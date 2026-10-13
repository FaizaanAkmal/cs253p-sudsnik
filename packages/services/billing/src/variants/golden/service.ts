import {
  CYCLE_UNIT_PRICE_MINOR,
  CURRENCIES,
  EXPECTED_CYCLE_UNITS,
  WASH_PRICE_MINOR,
  makeEnvelope,
  operatorOfHabitat,
  serviceUrlVar,
  toCurrency,
  type Ctx,
  type Envelope,
  type PayloadOf,
  type ServiceDeps,
} from "@sudsnik/contracts";
import type { Charge, LedgerEntry, LedgerFilter, Quote } from "@sudsnik/contracts/services/billing";
import { payloadSchemas } from "@sudsnik/contracts";
import type { Db } from "@sudsnik/infra-db";
import type { Outbox } from "@sudsnik/infra-queue";
import { err, newId, ok, sudsnikError, type Result } from "@sudsnik/kernel";
import type { BillingRuntime } from "../../runtime.js";

interface OperatorRow {
  pricing_tier: "standard" | "priority";
  currency: string;
}
interface ChargeRow {
  order_id: string;
  tenant_id: string;
  charge_id: string;
  amount: number;
  currency: string;
  state: Charge["state"];
  payment_ref: string | null;
  updated_at: number;
  failure: string | null;
  refund_pending: number;
}
interface LedgerRow {
  entry_id: string;
  tenant_id: string;
  order_id: string;
  kind: LedgerEntry["kind"];
  amount: number;
  currency: string;
  at: number;
  ref: string | null;
}
function publicCharge(row: ChargeRow): Charge {
  return {
    chargeId: row.charge_id,
    tenantId: row.tenant_id,
    orderId: row.order_id,
    amount: row.amount,
    currency: row.currency,
    state: row.state,
    ...(row.payment_ref ? { paymentRef: row.payment_ref } : {}),
    updatedAt: row.updated_at,
  };
}
function publicLedger(row: LedgerRow): LedgerEntry {
  return {
    entryId: row.entry_id,
    tenantId: row.tenant_id,
    orderId: row.order_id,
    kind: row.kind,
    amount: row.amount,
    currency: row.currency,
    at: row.at,
    ...(row.ref ? { ref: row.ref } : {}),
  };
}
export function createBilling(deps: ServiceDeps, db: Db, outbox: Outbox): BillingRuntime {
  const insertLedger = db.sqlite.prepare(
    "insert or ignore into ledger (entry_id, tenant_id, order_id, kind, amount, currency, at, ref) values (?, ?, ?, ?, ?, ?, ?, ?)",
  );

  function charge(orderId: string): ChargeRow | undefined {
    return db.readOne<ChargeRow>("select * from charges where order_id = ?", orderId);
  }
  function operator(tenantId: string): Result<OperatorRow> {
    const row = db.readOne<OperatorRow>("select pricing_tier, currency from operators where operator_id = ?", tenantId);
    if (!row || !(CURRENCIES as readonly string[]).includes(row.currency)) {
      return err(sudsnikError("FORBIDDEN", `unknown billing tenant ${tenantId}`));
    }
    return ok(row);
  }
  function quoteFor(orderId: string, tenantId: string): Result<Quote> {
    const account = operator(tenantId);
    if (!account.ok) return account;
    const currency = account.value.currency as (typeof CURRENCIES)[number];
    const base = toCurrency(WASH_PRICE_MINOR[account.value.pricing_tier], currency);
    return ok({
      orderId,
      amount: toCurrency(WASH_PRICE_MINOR[account.value.pricing_tier] + EXPECTED_CYCLE_UNITS * CYCLE_UNIT_PRICE_MINOR, currency),
      currency,
      breakdown: { base, cycleUnits: EXPECTED_CYCLE_UNITS, tier: account.value.pricing_tier },
    });
  }
  function putCharge(row: ChargeRow): void {
    db.write(
      `insert into charges (order_id, tenant_id, charge_id, amount, currency, state, payment_ref, updated_at, failure, refund_pending)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(order_id) do update set amount=excluded.amount, state=excluded.state,
         payment_ref=excluded.payment_ref, updated_at=excluded.updated_at, failure=excluded.failure,
         refund_pending=excluded.refund_pending`,
      row.order_id,
      row.tenant_id,
      row.charge_id,
      row.amount,
      row.currency,
      row.state,
      row.payment_ref,
      row.updated_at,
      row.failure,
      row.refund_pending,
    );
  }
  function addLedger(row: ChargeRow, kind: LedgerEntry["kind"], amount: number, at: number, ref?: string): boolean {
    return insertLedger.run(newId(), row.tenant_id, row.order_id, kind, amount, row.currency, at, ref ?? null).changes > 0;
  }
  function emit<T extends "charge.captured" | "charge.failed" | "refund.issued">(
    topic: T,
    tenantId: string,
    correlationId: string,
    payload: PayloadOf<T>,
    causationId?: string,
  ): void {
    outbox.enqueue(makeEnvelope({
      topic,
      tenantId,
      occurredAt: deps.clock.now(),
      correlationId,
      ...(causationId ? { causationId } : {}),
      payload,
    }));
  }

  async function finish(): Promise<void> {
    await outbox.pump();
  }

  function owned(row: ChargeRow | undefined, tenantId: string, orderId: string): Result<ChargeRow> {
    if (!row) return err(sudsnikError("NOT_FOUND", `no charge for order ${orderId}`));
    if (row.tenant_id !== tenantId) return err(sudsnikError("FORBIDDEN", `order ${orderId} belongs to another tenant`));
    return ok(row);
  }

  async function captureCharge(row: ChargeRow, ctx: Ctx, publish = true, recordLedger = true): Promise<Result<Charge>> {
    if (row.state === "captured" || row.state === "refunded") return ok(publicCharge(row));
    if (row.state !== "authorized" || !row.payment_ref) return err(sudsnikError("CONFLICT", `charge ${row.order_id} is ${row.state}`));
    const cycle = db.readOne<{ units: number }>("select units from cycle_units where order_id = ?", row.order_id);
    const units = cycle?.units ?? EXPECTED_CYCLE_UNITS;
    const cap = row.amount;
    const expected = quoteFor(row.order_id, row.tenant_id);
    if (!expected.ok) return expected;
    const actual = Math.min(cap, toCurrency(
      WASH_PRICE_MINOR[expected.value.breakdown.tier as "standard" | "priority"] + units * CYCLE_UNIT_PRICE_MINOR,
      row.currency as (typeof CURRENCIES)[number],
    ));
    const result = await deps.clients.payments.capture(row.payment_ref, actual, ctx);
    if (!result.ok) return result;
    const next: ChargeRow = { ...row, amount: result.value.amount, state: "captured", updated_at: deps.clock.now(), failure: null };
    db.transaction(() => {
      putCharge(next);
      if (recordLedger && addLedger(next, "capture", next.amount, next.updated_at, next.payment_ref ?? undefined) && publish) {
        emit("charge.captured", next.tenant_id, ctx.correlationId, {
          orderId: next.order_id, chargeId: next.charge_id, amount: next.amount, currency: next.currency,
        });
      }
    });
    await finish();
    return ok(publicCharge(next));
  }

  return {
    async quote(orderId, ctx) {
      return quoteFor(orderId, ctx.tenantId);
    },

    async authorize(orderId, amount, ctx) {
      const existing = charge(orderId);
      if (existing) {
        const access = owned(existing, ctx.tenantId, orderId);
        return access.ok
          ? existing.state === "failed"
            ? err(sudsnikError("CONFLICT", existing.failure ?? `charge ${orderId} failed`))
            : ok(publicCharge(existing))
          : access;
      }
      const priced = quoteFor(orderId, ctx.tenantId);
      if (!priced.ok) return priced;
      if (!Number.isSafeInteger(amount) || amount < 0) return err(sudsnikError("INVALID", "authorization amount must be a nonnegative integer"));
      const chargeId = newId();
      const callbackUrl = `${(deps.env[serviceUrlVar("billing")] ?? "").replace(/\/$/, "")}/callbacks`;
      const result = await deps.clients.payments.authorize({
        orderId,
        amount,
        currency: priced.value.currency,
        callbackUrl,
      }, ctx);
      const now = deps.clock.now();
      if (!result.ok) {
        if (result.error.retryable) return result;
        const failed: ChargeRow = {
          order_id: orderId, tenant_id: ctx.tenantId, charge_id: chargeId, amount, currency: priced.value.currency,
          state: "failed", payment_ref: null, updated_at: now, failure: result.error.message,
          refund_pending: 0,
        };
        db.transaction(() => {
          putCharge(failed);
          emit("charge.failed", ctx.tenantId, ctx.correlationId, { orderId, reason: result.error.message });
        });
        await finish();
        return result;
      }
      const authorized: ChargeRow = {
        order_id: orderId,
        tenant_id: ctx.tenantId,
        charge_id: chargeId,
        amount: result.value.amount,
        currency: result.value.currency,
        state: "authorized",
        payment_ref: result.value.paymentRef,
        updated_at: now,
        failure: null,
        refund_pending: 0,
      };
      db.transaction(() => {
        putCharge(authorized);
        addLedger(authorized, "authorize", authorized.amount, now, authorized.payment_ref ?? undefined);
      });
      return ok(publicCharge(authorized));
    },

    async capture(orderId, ctx) {
      const access = owned(charge(orderId), ctx.tenantId, orderId);
      if (!access.ok) return access;
      return captureCharge(access.value, ctx);
    },

    async refund(orderId, ctx) {
      let access = owned(charge(orderId), ctx.tenantId, orderId);
      if (!access.ok) return access;
      if (access.value.state === "refunded") return ok(publicCharge(access.value));
      if (access.value.state === "authorized") {
        const refundIntent = { ...access.value, refund_pending: 1 };
        db.write("update charges set refund_pending = 1 where order_id = ?", orderId);
        const captured = await captureCharge(refundIntent, ctx, false, false);
        if (!captured.ok) return captured;
        access = owned(charge(orderId), ctx.tenantId, orderId);
        if (!access.ok) return access;
      }
      if (access.value.state !== "captured" || !access.value.payment_ref) {
        return err(sudsnikError("CONFLICT", `charge ${orderId} is ${access.value.state}`));
      }
      const result = await deps.clients.payments.refund(access.value.payment_ref, access.value.amount, ctx);
      if (!result.ok) return result;
      const next: ChargeRow = { ...access.value, amount: result.value.amount, state: "refunded", updated_at: deps.clock.now(), failure: null, refund_pending: 0 };
      db.transaction(() => {
        putCharge(next);
        if (addLedger(next, "refund", -next.amount, next.updated_at, next.payment_ref ?? undefined)) {
          emit("refund.issued", next.tenant_id, ctx.correlationId, {
            orderId: next.order_id, refundId: next.charge_id, amount: next.amount, currency: next.currency,
          });
        }
      });
      await finish();
      return ok(publicCharge(next));
    },

    async ledger(filter: LedgerFilter, ctx) {
      const rows = filter.orderId
        ? db.read<LedgerRow>("select * from ledger where tenant_id = ? and order_id = ? order by seq desc limit ?", ctx.tenantId, filter.orderId, filter.limit)
        : db.read<LedgerRow>("select * from ledger where tenant_id = ? order by seq desc limit ?", ctx.tenantId, filter.limit);
      return ok(rows.map(publicLedger));
    },

    webhook(body, ctx) {
      const row = charge(body.orderId);
      if (!row) return err(sudsnikError("NOT_FOUND", `no charge for order ${body.orderId}`));
      if (row.payment_ref !== body.paymentRef || row.currency !== body.currency) {
        return err(sudsnikError("INVALID", "payment webhook does not match the charge"));
      }
      const duplicate = db.readOne<{ webhook_id: string }>("select webhook_id from webhook_dedupe where webhook_id = ?", body.id);
      if (duplicate) return ok({ accepted: true, duplicate: true });

      const current = row;
      const now = body.atMs;
      db.transaction(() => {
        db.write("insert into webhook_dedupe (webhook_id) values (?)", body.id);
        if (body.event === "captured" && current.state === "authorized") {
          const next = { ...current, amount: Math.min(current.amount, body.amount), state: "captured" as const, updated_at: now };
          putCharge(next);
          if (!current.refund_pending && addLedger(next, "capture", next.amount, now, body.paymentRef)) {
            emit("charge.captured", next.tenant_id, ctx.correlationId, {
              orderId: next.order_id, chargeId: next.charge_id, amount: next.amount, currency: next.currency,
            });
          }
        } else if (body.event === "refunded" && current.state === "captured") {
          const next = { ...current, amount: Math.min(current.amount, body.amount), state: "refunded" as const, updated_at: now, refund_pending: 0 };
          putCharge(next);
          if (addLedger(next, "refund", -next.amount, now, body.paymentRef)) {
            emit("refund.issued", next.tenant_id, ctx.correlationId, {
              orderId: next.order_id, refundId: next.charge_id, amount: next.amount, currency: next.currency,
            });
          }
        } else if (body.event === "failed" && current.state === "authorized") {
          const next = { ...current, state: "failed" as const, updated_at: now, failure: "payment processor reported failure" };
          putCharge(next);
          emit("charge.failed", next.tenant_id, ctx.correlationId, { orderId: next.order_id, reason: "payment processor reported failure" });
        }
      });
      return ok({ accepted: true, duplicate: false });
    },

    async ingest(envelope) {
      const parsed = payloadSchemas[envelope.topic].safeParse(envelope.payload);
      if (!parsed.success) return err(sudsnikError("INVALID", `bad ${envelope.topic} payload: ${parsed.error.message}`));
      const seen = db.readOne<{ event_id: string }>("select event_id from event_dedupe where event_id = ?", envelope.id);
      if (seen) return ok(undefined);

      if (envelope.topic === "operator.updated") {
        const update = parsed.data as PayloadOf<"operator.updated">;
        db.transaction(() => {
          db.write(
            `insert into operators (operator_id, pricing_tier, currency) values (?, ?, ?)
             on conflict(operator_id) do update set pricing_tier=excluded.pricing_tier, currency=excluded.currency`,
            update.operatorId, update.pricingTier, update.currency,
          );
          db.write("insert into event_dedupe (event_id) values (?)", envelope.id);
        });
        return ok(undefined);
      }
      if (envelope.topic === "wash.completed") {
        const completed = parsed.data as PayloadOf<"wash.completed">;
        db.transaction(() => {
          db.write("insert into event_dedupe (event_id) values (?)", envelope.id);
          db.write(
            `insert into cycle_units (order_id, units) values (?, ?)
             on conflict(order_id) do update set units=units+excluded.units`,
            completed.orderId, completed.cycleUnits,
          );
        });
        return ok(undefined);
      }
      if (envelope.topic === "order.returned") {
        const returned = parsed.data as PayloadOf<"order.returned">;
        const tenantId = (() => {
          try {
            return operatorOfHabitat(returned.habitatId);
          } catch {
            return undefined;
          }
        })();
        if (!tenantId || tenantId !== envelope.tenantId) {
          return err(sudsnikError("FORBIDDEN", `returned order ${returned.orderId} has an invalid tenant`));
        }
        const ctx: Ctx = { tenantId, correlationId: envelope.correlationId, idempotencyKey: `capture-${returned.orderId}` };
        const current = owned(charge(returned.orderId), tenantId, returned.orderId);
        if (!current.ok) return current;
        const result = await captureCharge(current.value, ctx);
        if (!result.ok) return result;
        db.write("insert into event_dedupe (event_id) values (?)", envelope.id);
        return ok(undefined);
      }
      return err(sudsnikError("INVALID", `billing does not consume ${envelope.topic}`));
    },
  };
}
