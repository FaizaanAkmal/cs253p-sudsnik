# tracking

Shuttle positions and pod locations. `GET /positions/:shuttleId` fetches a fresh position from `ephemeris`; `GET /positions/cached/:shuttleId` uses the in-memory TTL cache, falling back to the latest relay position persisted in `tracking.sqlite` (and fetching only when neither has a value). Fresh reads and position callbacks warm the cache. `GET /positions` asks for all six shuttles and returns each with `source: "fresh"`. `GET /pods/:podId` is the pod's last known place (`habitat`, `shuttle`, or `node`) built from the dispatch events `src/handlers/` consumes, visible only to the pod's tenant.

`POST /callbacks/relay` takes `RelayCallback` of kind `position`: the checksum is verified, the body id deduped, the newest observation per shuttle kept, and `position.updated` published through the outbox.

Tables in `tracking.sqlite`: `positions` (last known per shuttle, written by the relay callback), `pod_locations` (per pod, with the order that moved it), `callbacks` and `handled` (dedupe by callback id and envelope id), `rejected_callbacks` (a callback whose checksum did not verify).

`src/app.ts` holds what the service is made of — the app, the relay ingest, the pod lookup — and `src/variants/` supplies the reads over it; `src/index.ts` selects it.
