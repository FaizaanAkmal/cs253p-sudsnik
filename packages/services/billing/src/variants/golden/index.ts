import type { ServiceDeps } from "@sudsnik/contracts";
import { serviceDataFile } from "@sudsnik/infra-boot";
import { openDb } from "@sudsnik/infra-db";
import { createOutbox, registerHandlers } from "@sudsnik/infra-queue";
import { baseApp } from "../../app.js";
import { handlersDir, migrationsDir } from "../../paths.js";
import { registerRoutes } from "../../routes.js";
import { bindRuntime } from "../../runtime.js";
import { createBilling } from "./service.js";

export const variant = "golden";
export { createBilling };

export async function createApp(deps: ServiceDeps) {
  const app = await baseApp(deps, variant);
  const db = openDb({ path: serviceDataFile(deps), service: deps.service, meter: deps.meter, migrationsDir });
  const outbox = createOutbox(db, deps.bus);
  const billing = createBilling(deps, db, outbox);
  bindRuntime(deps, billing);
  registerRoutes(app, billing);
  app.sudsnik.registerStop(() => db.close());
  app.sudsnik.registerStop(() => outbox.stop());
  const handlers = await registerHandlers(deps, handlersDir);
  for (const handler of handlers) app.sudsnik.registerStop(handler.stop);
  outbox.start();
  app.sudsnik.setReady(true);
  return app;
}
