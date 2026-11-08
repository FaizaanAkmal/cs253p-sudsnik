import type { AlertRule } from "@sudsnik/contracts";

const rule: AlertRule = {
  name: "notify_relay_delivery_failure",
  every: 60_000,
  evaluate: ({ counters }) =>
    (counters["notify.relay_failures"] ?? 0) > 0 ||
    (counters["notify.dead_letters"] ?? 0) > 0,
};

export default rule;
