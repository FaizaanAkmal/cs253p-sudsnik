import { fileURLToPath } from "node:url";
import type { ServiceDeps } from "@sudsnik/contracts";
import { bootService } from "@sudsnik/infra-boot";
import { createServiceApp, handlersDir, type NotifyApp, type VariantRuntime, type Wiring } from "../../app.js";
import { inLinkWindow } from "../../delivery/window.js";
import { send, settle, type DeliveryState } from "../../delivery/relay.js";
import { readEnv } from "../../env.js";
import { next, pipeline, stage } from "../../pipeline.js";
import { parse, persist, render, resolve, type IngestState } from "../../queue/ingest.js";
import type { NotificationState } from "../../queue/store.js";
import { ingestWith, observer, port, sweeper } from "../../service.js";

export const variant = "exactly-once";
export { readEnv, handlersDir };
const alertsDir = fileURLToPath(new URL("../../alerts/", import.meta.url));

const MAX_ATTEMPTS = 5;

/** Dedupes event envelopes, retries transient relay failures, and dead-letters permanent or exhausted deliveries. */
export function runtime(w: Wiring): VariantRuntime {
  const observe = observer(w.deps);
  const deliver = pipeline<DeliveryState>("deliver", [send(w), settle(w, { maxAttempts: MAX_ATTEMPTS, honorRetryAfter: true })], observe);
  const initialState = (habitatId: string, now: number): NotificationState => (inLinkWindow(habitatId, now) ? "queued" : "digested");
  const deliverySweep = sweeper({ w, deliver });
  const dispatch = stage<IngestState>("dispatch", async (s) => {
    if (s.notification) {
      deliverySweep.notePending();
      if (inLinkWindow(s.notification.habitat_id, s.now)) await deliver({ notification: s.notification, now: s.now, attempt: 0 });
    }
    return next(s);
  });
  const ingest = pipeline<IngestState>(
    "ingest",
    [parse(), resolve(w), render(), persist(w, { first: (ctx, id, tenant, notification, now) => ctx.store.markSeen(tenant, id, notification, now), initialState }), dispatch],
    observe,
  );
  const api = port({ w, deliver, initialState, dispatchOnWrite: inLinkWindow, onPending: deliverySweep.notePending });
  return {
    ingest: (envelope) => ingestWith(ingest, w.deps, envelope),
    send: api.send,
    digest: api.digest,
    sweep: deliverySweep.sweep,
    stop: () => undefined,
  };
}

export function createApp(deps: ServiceDeps): Promise<NotifyApp> {
  return createServiceApp(deps, { variant, alertsDir, runtime });
}

export function start(): Promise<unknown> {
  return bootService({ service: "notify", readEnv, createApp, handlersDir });
}
