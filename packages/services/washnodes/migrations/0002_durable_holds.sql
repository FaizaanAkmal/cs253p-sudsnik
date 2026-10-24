-- Expand: add tenant-scoped lookup support while the existing hold index remains available.
create index holds_tenant_order on holds (tenant_id, order_id);

-- Migrate: restore washer claims from live holds before enforcing the single-live-hold invariant.
update washers
set state = 'held',
    hold_id = (select hold_id from holds where holds.washer_id = washers.washer_id and state = 'held' order by acquired_at desc limit 1)
where exists (select 1 from holds where holds.washer_id = washers.washer_id and state = 'held');

-- Contract: enforce one live hold per washer and replace the unscoped order index.
create unique index holds_one_live_per_washer on holds (washer_id) where state = 'held';
drop index holds_order;
