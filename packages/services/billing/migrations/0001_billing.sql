create table operators (
  operator_id text primary key,
  pricing_tier text not null check (pricing_tier in ('standard', 'priority')),
  currency text not null check (length(currency) = 3)
);

insert into operators (operator_id, pricing_tier, currency) values
  ('op1', 'standard', 'USD'),
  ('op2', 'priority', 'EUR'),
  ('op3', 'standard', 'AUD'),
  ('op4', 'priority', 'USD');

create table charges (
  order_id text primary key,
  tenant_id text not null,
  charge_id text not null unique,
  amount integer not null check (amount >= 0),
  currency text not null,
  state text not null check (state in ('authorized', 'captured', 'failed', 'refunded')),
  payment_ref text unique,
  updated_at integer not null,
  failure text,
  refund_pending integer not null default 0
);

create table ledger (
  seq integer primary key autoincrement,
  entry_id text not null unique,
  tenant_id text not null,
  order_id text not null,
  kind text not null check (kind in ('authorize', 'capture', 'refund', 'fee')),
  amount integer not null,
  currency text not null,
  at integer not null,
  ref text,
  unique (order_id, kind)
);
create index ledger_order_seq on ledger (order_id, seq desc);

create table cycle_units (
  order_id text primary key,
  units integer not null
);
create table event_dedupe (event_id text primary key);
create table webhook_dedupe (webhook_id text primary key);
