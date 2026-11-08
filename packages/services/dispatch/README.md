# `@sudsnik/service-dispatch`

Shuttle assignment for the physical flow: a pickup window and a wash-node hold for every placed order, a return window
when the wash completes, and ingest of the relay's `collected`, `delivered`, and `returned` callbacks. The contract is
`packages/contracts/src/services/dispatch/`, and what the service owes is `docs/system-spec.md` §9.4.

Modules by concern under `src/`: `scheduler.ts` (pickup, return, reassign, cancel, and the back-pressure queue),
`holds.ts` (node ranking and holds through `washnodes`), `shuttles.ts` (round-robin with trip capacity), `windows.ts`
(link windows), `ingest.ts` (relay callbacks), `store.ts` (every SQL statement), `publisher.ts` (events through the
outbox), `runtime.ts` (how directory-scanned handlers reach the app), `gate.ts` (the drain: every route, delivery, and
sweep runs through it), `app.ts` (the shared app), `strategy.ts` (what `src/variants/` supplies, which `src/index.ts`
selects).

The selected `golden` strategy caches link windows for one orbit and node status for one minute, and coalesces
concurrent misses. It does not fetch shuttle positions that scheduling does not use. A breaker logs `breaker_state`
when `ephemeris` refuses a call; while it is open, windows come from the canon schedule, node choice rotates locally,
and a return waits for contact rather than failing. The `naive` variant remains available for comparison. The selected
callback ingest verifies relay checksums, deduplicates callback ids, and applies any missing earlier journey steps
before the reported step. Callbacks that cannot be processed are recorded in `rejected_callbacks`.

A pod holds a washer only once it has arrived: `order.placed` schedules a window and a node, the `delivered` callback
acquires the hold and publishes `pod.delivered`. A node with no idle washer is waited on, not polled: the pod is woken by
the `hold.released`, `hold.expired`, or `wash.completed` that frees a washer there, oldest waiting pod first, with a
once-per-orbit sweep as the backstop. Waiting is unbounded and is not a failure; running the attempts out is, and it
publishes `pickup.failed` with the reason and the attempt count in the same transaction that marks the order `failed`,
so an order dispatch abandons never goes quiet.

Tables in `dispatch.sqlite` (`migrations/`): `orders` (what `order.placed` said, how far the pod has come, and the node
it waits at), `assignments`, `holds`, `trips` (pods per shuttle per window), `rotation`, `shuttle_positions`,
`consumed_events` (envelope ids, written by every handler), `relay_callbacks` (callback ids, which the ingest does
not write), `rejected_callbacks` (a callback for an order dispatch does not know, or one out of
step), and the outbox.

On `SIGTERM` the stops run in reverse registration order: the timers and consumers stop, the gate refuses new work and
waits for the routes, deliveries, and sweeps already running, the outbox publishes what they wrote, and the database
closes last, so no statement can reach a closed database.
