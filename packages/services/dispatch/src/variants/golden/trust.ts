import { err, ok, sudsnikError, type Result } from "@sudsnik/kernel";
import { STEPS, stepIndex, type IngestTrust, type PodCallback, type StepRange } from "../../ingest.js";

export function goldenTrust(): IngestTrust {
  return {
    verify: () => true,
    fresh: () => true,
    range(body: PodCallback, progress: number): Result<StepRange> {
      const target = stepIndex(body.kind);
      if (progress < target - 1) return err(sudsnikError("CONFLICT", `${body.kind} for order ${body.orderId} before ${STEPS[target - 2]}`));
      return ok({ from: target, to: target });
    },
  };
}
