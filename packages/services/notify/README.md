# notify

Renders a notification per consumed event and delivers it to the habitat through `relay`. Port: `NotifyService` (`contracts/src/services/notify/`): `POST /notifications` sends one on request, `GET /habitats/:habitatId/digest` lists what is still waiting for a habitat and when its next link window opens.

## Shape

Event-driven: `src/handlers/` (one per consumed topic, dispatching to the runtime `src/runtime.ts` bound), `src/templates/` (topic to `{ title, body }` and the channel it goes out on), `src/queue/` (ingest stages and the SQL store), `src/delivery/` (window and relay stages). Stages are `stage(name, fn)` composed with `pipeline` (`src/pipeline.ts`); `src/variants/exactly-once/` composes the ingest and delivery pipelines the service runs, and `src/index.ts` selects it.

Ingest is `parse`, `resolve` (the habitat the event names, else the one the orders table knows, else the one a pod id embeds), `render`, `persist`, and a dispatch stage that sends only in a link window. The envelope id is deduplicated in the same transaction as the notification. Delivery records every relay attempt, honors `Retry-After`, and dead-letters permanent failures or notifications after five failed attempts; a one-minute sweep retries due notifications when their habitat is visible.

## Tables (`notify.sqlite`, `migrations/`)

| Table | Holds |
|---|---|
| `notifications` | One row per notification: habitat, template, rendered text, state, attempts, retry hold |
| `deliveries` | One row per relay attempt and its outcome |
| `orders` | `orderId` to `habitatId`, filled by the events that name both |
| `dedupe` | Envelope ids per tenant, written atomically with the notification |
| `dead_letters` | Notifications that spent the retry budget or had a permanent relay refusal |
| `outbox` | `infra/queue`'s table, pumped to the bus |
