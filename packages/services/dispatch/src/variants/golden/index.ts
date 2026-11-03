import { fileURLToPath } from "node:url";
import { MINUTE_MS, NODES, ORBIT_MS, type ServiceDeps } from "@sudsnik/contracts";
import type { NodeStatusResponse, Window } from "@sudsnik/contracts/mocks/ephemeris";
import { createCache, type Cache } from "@sudsnik/infra-cache";
import { createBreaker } from "@sudsnik/infra-resilience";
import { err, ok, type Result } from "@sudsnik/kernel";
import { buildApp } from "../../app.js";
import { rankerWithFallback, roundRobinRanker, statusRanker } from "../../holds.js";
import type { Store } from "../../store.js";
import type { Strategy } from "../../strategy.js";
import { cachedWindows, canonWindow } from "../../windows.js";
import { goldenTrust } from "./trust.js";

export const variant = "golden";
export const handlersDir = fileURLToPath(new URL("../../handlers/", import.meta.url));

function memoized<T>(cache: Cache<T>, pending: Map<string, Promise<Result<T>>>, key: string, load: () => Promise<Result<T>>): Promise<Result<T>> {
  const active = pending.get(key);
  if (active) return active;
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(ok(hit));
  const request = load().then((result) => {
    if (result.ok) cache.set(key, result.value);
    return result;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

export function goldenStrategy(deps: ServiceDeps, store: Store): Strategy {
  const ephemeris = deps.clients.ephemeris;
  const breaker = createBreaker({
    failureThreshold: 1,
    openMs: ORBIT_MS,
    clock: deps.clock,
    name: "ephemeris",
    onStateChange: (from, to) => deps.telemetry.logger.warn("breaker_state", { name: "ephemeris", from, to }),
  });
  const windowsCache = createCache<Window[]>({ max: 16, ttlMs: ORBIT_MS, clock: deps.clock, meter: deps.meter, service: deps.service });
  const statusCache = createCache<NodeStatusResponse>({
    max: NODES.length,
    ttlMs: MINUTE_MS,
    clock: deps.clock,
    meter: deps.meter,
    service: deps.service,
  });
  const statusPending = new Map<string, Promise<Result<NodeStatusResponse>>>();
  const status = (nodeId: string, ctx: Parameters<typeof ephemeris.status>[1]) =>
    memoized(statusCache, statusPending, nodeId, () => breaker.exec(() => ephemeris.status(nodeId, ctx)));
  const windows = cachedWindows(
    { ...ephemeris, windows: (habitatId, ctx) => breaker.exec(() => ephemeris.windows(habitatId, ctx)) },
    windowsCache,
  );

  return {
    windows: {
      async next(habitatId, nowMs, ctx) {
        const result = await windows.next(habitatId, nowMs, ctx);
        return result.ok || breaker.state() !== "open" ? result : ok(canonWindow(habitatId, nowMs));
      },
    },
    nodes: rankerWithFallback(
      statusRanker((nodeId, ctx) => status(nodeId, ctx)),
      roundRobinRanker(store),
      () => breaker.state() === "open",
    ),
    async inContact(nodeId, ctx) {
      const result = await status(nodeId, ctx);
      if (result.ok) return ok(result.value.inContact);
      return breaker.state() === "open" ? ok(false) : err(result.error);
    },
    ingest: goldenTrust,
  };
}

export function createApp(deps: ServiceDeps) {
  return buildApp(deps, variant, goldenStrategy);
}
