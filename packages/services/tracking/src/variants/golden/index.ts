import { SHUTTLES, type ServiceDeps } from "@sudsnik/contracts";
import type { Position } from "@sudsnik/contracts/services/tracking";
import { createCache } from "@sudsnik/infra-cache";
import { ok, type Result } from "@sudsnik/kernel";
import type { StoredPosition } from "../../store.js";
import { buildApp, cached, fresh, ingest, podLocation } from "../../app.js";
import type { Tracking } from "../../routes.js";

export const CACHE_MAX = SHUTTLES.length;

export const createApp = (deps: ServiceDeps) =>
  buildApp(deps, "golden", (parts): Tracking => {
    const cache = createCache<StoredPosition>({
      max: CACHE_MAX,
      ttlMs: parts.ttlMs,
      clock: deps.clock,
      meter: deps.meter,
      service: deps.service,
    });
    const pending = new Map<string, Promise<Result<Position>>>();

    function remember(position: StoredPosition): void {
      const current = cache.get(position.shuttleId);
      if (!current || position.observedAt >= current.observedAt) cache.set(position.shuttleId, position);
    }

    async function position(shuttleId: string, ctx: Parameters<typeof deps.clients.ephemeris.position>[1]): Promise<Result<Position>> {
      const result = await deps.clients.ephemeris.position(shuttleId, ctx);
      if (!result.ok) return result;
      const stored = { shuttleId, orbitPhase: result.value.orbitPhase, observedAt: result.value.atMs };
      remember(stored);
      return ok(fresh(result.value));
    }

    async function positionCached(shuttleId: string, ctx: Parameters<typeof deps.clients.ephemeris.position>[1]): Promise<Result<Position>> {
      const active = pending.get(shuttleId);
      if (active) return active;
      const hit = cache.get(shuttleId);
      if (hit) return Promise.resolve(ok(cached(hit)));

      const stored = parts.store.position(shuttleId);
      if (stored) {
        remember(stored);
        return Promise.resolve(ok(cached(stored)));
      }

      const request = deps.clients.ephemeris.position(shuttleId, ctx).then((result) => {
        if (!result.ok) return result;
        const found = { shuttleId, orbitPhase: result.value.orbitPhase, observedAt: result.value.atMs };
        remember(found);
        return ok(cached(found));
      }).finally(() => pending.delete(shuttleId));
      pending.set(shuttleId, request);
      return request;
    }

    return {
      position,
      positionCached,
      async positions(ctx) {
        const positions: Position[] = [];
        for (const shuttleId of SHUTTLES) {
          const result = await position(shuttleId, ctx);
          if (!result.ok) return result;
          positions.push(result.value);
        }
        return ok(positions);
      },
      podLocation: podLocation(parts),
      relay: (body, ctx) => ingest(parts, body, ctx, remember),
    };
  });
