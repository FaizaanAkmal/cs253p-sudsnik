import type { AlertRule } from "@sudsnik/contracts";

const rule: AlertRule = {
  name: "dispatch_relay_ingest_fault",
  every: 60_000,
  evaluate: ({ counters }) =>
    (counters["dispatch.callback_duplicates"] ?? 0) > 0 ||
    (counters["dispatch.callback_out_of_order"] ?? 0) > 0 ||
    (counters["dispatch.callback_rejected"] ?? 0) > 0,
};

export default rule;
