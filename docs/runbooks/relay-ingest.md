# Runbook: relay ingest faults

Use this when a `dispatch_relay_ingest_fault` or `notify_relay_delivery_failure` alert fires, or callbacks and
notifications stop progressing. Both alerts are signals to inspect the recorded fault; a repeat or a reordered
callback is tolerated and does not by itself mean the pod is stuck.

## 1. Find the fault

Check `logs/dispatch.jsonl` and `logs/notify.jsonl` for the alert and surrounding `stage_failed` records. Then inspect
the durable service rows:

```sh
sqlite3 "$SUDSNIK_DATA_DIR/dispatch.sqlite" \
  "select callback_id, tenant_id, reason, body, received_at from rejected_callbacks order by seq desc limit 20;"
sqlite3 "$SUDSNIK_DATA_DIR/notify.sqlite" \
  "select notification_id, tenant_id, attempts, reason, dead_at from dead_letters order by dead_at desc limit 20;"
sqlite3 "$SUDSNIK_DATA_DIR/notify.sqlite" \
  "select notification_id, state, attempts, not_before from notifications where state in ('queued', 'digested', 'failed') order by created_at;"
```

For a bus consumer that exhausted its deliveries (for example, `notify` could not resolve an order yet), inspect
`dead_letters` in `bus.sqlite` as well. A retryable `not yet known` resolution can be replayed after its cause arrives;
malformed or unaddressable events need their payload corrected before replay.

## 2. Replay only after repair

Dispatch records callback ids before attempting their journey steps. Once the missing order or node assignment is
restored, remove the rejected callback's dedupe mark so the relay can submit the corrected callback again. Do not do
this if any progress was applied for that callback.

```sh
sqlite3 "$SUDSNIK_DATA_DIR/dispatch.sqlite" \
  "delete from relay_callbacks where id = '<callback_id>' and tenant_id = '<tenant_id>';"
```

For a notify dead letter, first restore relay availability and confirm the habitat is in a link window. Requeue the
notification so the normal sweep can retry it; keep `deliveries` as the audit trail:

```sh
sqlite3 "$SUDSNIK_DATA_DIR/notify.sqlite" <<'SQL'
begin immediate;
update notifications set state = 'queued', attempts = 0, not_before = 0
  where notification_id = '<notification_id>' and state = 'failed';
delete from dead_letters where notification_id = '<notification_id>';
commit;
SQL
```

Confirm dispatch progress or a delivered notification in the service database, and confirm the corresponding
`pod.*` or `notification.failed` event in `bus.sqlite`. Keep the rejected/dead-letter payload and reason in the
incident record before clearing or replaying anything.
