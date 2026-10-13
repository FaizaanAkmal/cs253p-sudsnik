import type { Ctx, Envelope, Handler, ServiceDeps, Topic } from "@sudsnik/contracts";
import type { BillingService } from "@sudsnik/contracts/services/billing";
import type { PaymentsWebhook } from "@sudsnik/contracts/mocks/payments";
import { err, type Result } from "@sudsnik/kernel";

export interface Runtime {
  ingest(envelope: Envelope): Promise<Result<void>>;
}

export interface BillingRuntime extends BillingService, Runtime {
  webhook(body: PaymentsWebhook, ctx: Ctx): Promise<Result<{ accepted: boolean; duplicate: boolean }>>;
}

const runtimes = new WeakMap<ServiceDeps, Runtime>();

export function bindRuntime(deps: ServiceDeps, runtime: Runtime): void {
  runtimes.set(deps, runtime);
}

export function handlerFor(topic: Topic): Handler {
  return {
    topic,
    async handle(envelope, deps) {
      const runtime = runtimes.get(deps);
      if (!runtime) return err({ code: "INTERNAL", message: `billing has no runtime bound for ${topic}`, retryable: true });
      return runtime.ingest(envelope);
    },
  };
}
