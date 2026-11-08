import { err, ok, sudsnikError, type Result } from "@sudsnik/kernel";
import type { RelayCallback } from "@sudsnik/contracts/mocks/relay";
import { checksumVerifies } from "../../checksum.js";
import { STEPS, stepIndex, type IngestTrust, type PodCallback, type StepRange } from "../../ingest.js";
import type { Store } from "../../store.js";

export function goldenTrust(store: Store): IngestTrust {
  return {
    verify: (body: RelayCallback) => checksumVerifies({ ...body }),
    fresh: (entry, nowMs) => store.recordCallback(entry, nowMs),
    range(body: PodCallback, progress: number): Result<StepRange> {
      if (progress > STEPS.length) return err(sudsnikError("CONFLICT", `invalid progress ${progress} for order ${body.orderId}`));
      const target = stepIndex(body.kind);
      if (progress >= target) return ok(undefined);
      return ok({ from: progress + 1, to: target });
    },
  };
}
