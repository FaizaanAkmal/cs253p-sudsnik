import type { ErrorBody, ServiceDeps } from "@sudsnik/contracts";
import { routes } from "@sudsnik/contracts/services/billing";
import { registerHandlers } from "@sudsnik/infra-queue";
import { ok } from "@sudsnik/kernel";
import { z } from "zod";
import { IdSchema, IdempotencyHeaders } from "@sudsnik/contracts";
import { baseApp } from "../../app.js";
import { handlersDir } from "../../paths.js";
import { bindRuntime } from "../../runtime.js";
import type { Runtime } from "../../runtime.js";

export const variant = "hollow";

export async function createApp(deps: ServiceDeps) {
  const app = await baseApp(deps, variant);
  const body: ErrorBody = { code: "UNAVAILABLE", message: `${deps.service} is hollow`, retryable: true };
  const runtime: Runtime = { async ingest() { return ok(undefined); } };
  bindRuntime(deps, runtime);
  const orderParams = z.object({ orderId: IdSchema });
  for (const route of Object.values(routes)) {
    const schema = {
      ...(route.path.includes(":orderId") ? { params: orderParams } : {}),
      ...("body" in route && route.body ? { body: route.body } : {}),
      ...("query" in route && route.query ? { querystring: route.query } : {}),
      ...("idempotent" in route && route.idempotent ? { headers: IdempotencyHeaders } : {}),
    };
    app.route({
      method: route.method,
      url: route.path,
      schema,
      handler: async (_req, reply) => reply.code(501).send(body),
    });
  }
  const handlers = await registerHandlers(deps, handlersDir);
  for (const handler of handlers) app.sudsnik.registerStop(handler.stop);
  app.sudsnik.setReady(true);
  return app;
}
