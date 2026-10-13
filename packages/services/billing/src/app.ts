import type { CostResponse, Meter, ServiceDeps } from "@sudsnik/contracts";
import { createBaseApp } from "@sudsnik/infra-http";

export const VERSION = "1.0.0";

function costOf(deps: ServiceDeps): CostResponse {
  const meter = deps.meter as Meter & { cost?: (service: string) => CostResponse };
  return meter.cost ? meter.cost(deps.service) : { service: deps.service, sinceMs: 0, totalUnits: 0, byOperation: {}, byEndpoint: {} };
}

export function baseApp(deps: ServiceDeps, variant: string) {
  return createBaseApp({ deps, version: VERSION, variant, cost: () => costOf(deps) });
}
