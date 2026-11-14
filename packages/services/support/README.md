# support

Pod anomaly reports in free text, triaged into `{ category, severity, action }` by a `TriageWorkflow`, with escalation on request (`docs/system-spec.md` §9.10).

Routes: `POST /reports` stores a report, publishes `anomaly.reported`, and triages it in the same request; `GET /reports/:id`; `POST /reports/:id/triage` re-runs triage on demand and publishes `triage.completed`; `POST /reports/:id/escalate` marks it `escalated`. Consumes `order.returned` (recorded), `wash.faulted` (opens a report `washer <washerId> fault <faultCode>`), `notification.failed` (recorded). Every handler dedupes on the envelope id.

Tables (`support.sqlite`, `migrations/`): `reports`, `triage_results` (append-only; `reports.triage_id` names the current one), `orders_seen`, `notification_failures`, `eval_fixtures` (the copy the eval scores from), `handled_events` (dedupe), `token_usage` (tokens spent per orbit), plus the infra outbox.

Triage asks the oracle for one checked JSON answer, retrying once with a stricter prompt if it does not fit. Invalid answers and notes after the per-orbit token budget use the keyword table (`src/workflow/keywords.ts`). The keyword table is also the safety fallback for notes carrying instructions; those notes are marked `guarded` and are never returned as `clean`. Oracle tokens are metered and recorded per orbit, and an unavailable oracle leaves a report received so its triage can be retried.

Layout: `src/workflow/` holds the cue table and `validate.ts` (the triage field set and the parser that reads them out of a completion); `src/variants/oracle/` composes the selected workflow and `src/index.ts` selects it; `src/service.ts` is the port over `src/store.ts`; `src/routes.ts` the routes; `src/handlers/` the consumers, reaching the app through `src/handlerContext.ts`; `src/eval/` the eval runner; `src/schema.ts` the Drizzle tables; `src/app.ts` wires them.

`npm run eval [-- --set triage|hostile|all]` runs the workflow over the oracle fixtures against the in-process mock and prints precision and recall per set.
