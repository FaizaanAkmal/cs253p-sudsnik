# `@sudsnik/service-orders`

The order lifecycle of `docs/system-spec.md` §9.3: `place`, `cancel`, `get`, `list` over `orders.sqlite`, the transition table as data in `src/stateMachine.ts`, and saga coordination with `dispatch` (by event), `washnodes` (by event), and `billing` (HTTP behind `billing.enabled`, retried once per orbit by the reconciliation job, which also picks up orders placed or cancelled while the flag was off).

`POST /orders/:orderId/cancel` answers 200 with the cancelled order for states in `CANCELLABLE_STATES`; other states return 409. The state change, `cancel` saga step, and `order.cancelled` event are recorded in one transaction. An authorized payment is refunded after that transaction commits; dispatch releases an existing hold from the event. System cancellation after a final `wash.faulted` or `pickup.failed` uses the same path with `origin` `system`.

Layout: `src/core/` holds the implementation (`OrdersService`, `OrderRepository` over Drizzle with `src/schema.ts`, the routes, and `composeApp`); `src/handlers/` holds one thin class per consumed topic that hands the envelope to whichever service `createApp(deps)` bound; `src/variants/cancel/` supplies the port's `cancel` over it, and `src/index.ts` selects it.

Tables (`migrations/`): `orders` (`order_id`, `tenant_id`, `state`, `payment`, timestamps, the optional `Order` fields), `saga_steps` (`order_id`, `step`, `at`, `detail`, `envelope_id` for the event that caused the step; steps are `place`, `authorize[:pending|:failed]`, `cancel`, `refund[:pending|:failed]`, and the topic of every applied event), `consumed` (envelope ids for handler dedupe), and the `outbox` from `infra/queue`.

```sh
npx vitest run --project orders
```
