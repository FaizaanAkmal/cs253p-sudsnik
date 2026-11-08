import { createHash } from "node:crypto";
import { err, ok, sudsnikError, type Result } from "@sudsnik/kernel";
import type { RelayCallback } from "@sudsnik/contracts/mocks/relay";
import { STEPS, stepIndex, type IngestTrust, type PodCallback, type StepRange } from "../../ingest.js";
import type { Store } from "../../store.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function verifies(body: RelayCallback): boolean {
  const { checksum, ...unsigned } = body;
  return createHash("sha256").update(canonical(unsigned)).digest("hex").slice(0, 8) === checksum;
}

export function goldenTrust(store: Store): IngestTrust {
  return {
    verify: verifies,
    fresh: (entry, nowMs) => store.recordCallback(entry, nowMs),
    range(body: PodCallback, progress: number): Result<StepRange> {
      if (progress > STEPS.length) return err(sudsnikError("CONFLICT", `invalid progress ${progress} for order ${body.orderId}`));
      const target = stepIndex(body.kind);
      if (progress >= target) return ok(undefined);
      return ok({ from: progress + 1, to: target });
    },
  };
}
