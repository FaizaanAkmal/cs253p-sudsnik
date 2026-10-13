import { afterEach, describe, expect, it } from "vitest";
import { makeEnvelope } from "@sudsnik/contracts";
import { fakeDeps } from "@sudsnik/contracts/testing";
import { err, sudsnikError } from "@sudsnik/kernel";
import type { createApp } from "../../src/index.js";
import { handlersDir } from "../../src/index.js";
import { createApp as createGolden } from "../../src/variants/golden/index.js";
import { createApp as createHollow } from "../../src/variants/hollow/index.js";

type App = Awaited<ReturnType<typeof createApp>>;

async function boot() {
  const deps = fakeDeps("00000000c0ffee00", "billing", { handlersDir });
  const captured: Array<{ paymentRef: string; amount: number | undefined }> = [];
  const refunded: Array<{ paymentRef: string; amount: number | undefined }> = [];
  const authorizeKeys: string[] = [];
  deps.clients.payments.authorize = async (req) => ({
    ok: true,
    value: { paymentRef: `pay-${req.orderId}`, state: "authorized", amount: req.amount, currency: req.currency },
  });
  deps.clients.payments.capture = async (paymentRef, amount) => {
    captured.push({ paymentRef, amount });
    return { ok: true, value: { paymentRef, state: "captured", amount: amount ?? 0, currency: "USD" } };
  };
  deps.clients.payments.refund = async (paymentRef, amount) => {
    refunded.push({ paymentRef, amount });
    return { ok: true, value: { paymentRef, state: "refunded", amount: amount ?? 0, currency: "USD" } };
  };
  const app = await createGolden(deps) as App;
  return { app, deps, captured, refunded, authorizeKeys };
}

async function stop(app: App) {
  await app.sudsnik.drain();
}

const tenant = { "x-sudsnik-tenant": "op1" };
const writeHeaders = (key: string) => ({ ...tenant, "idempotency-key": key });

describe("billing", () => {
  let app: App | undefined;

  afterEach(async () => {
    if (app) await stop(app);
    app = undefined;
  });

  it("quotes canon pricing in each operator's currency and tier", async () => {
    const stack = await boot();
    app = stack.app;
    const standard = await app.inject({ method: "GET", url: "/quotes/order-1", headers: tenant });
    const priority = await app.inject({ method: "GET", url: "/quotes/order-2", headers: { "x-sudsnik-tenant": "op2" } });
    expect(standard.json()).toEqual({
      orderId: "order-1",
      amount: 5_260,
      currency: "USD",
      breakdown: { base: 4_900, cycleUnits: 120, tier: "standard" },
    });
    expect(priority.json()).toEqual({
      orderId: "order-2",
      amount: 7_599,
      currency: "EUR",
      breakdown: { base: 7_268, cycleUnits: 120, tier: "priority" },
    });
  });

  it("registers contract-schema routes on both API versions", async () => {
    const stack = await boot();
    app = stack.app;
    expect((await app.inject({ method: "GET", url: "/v2/quotes/contract-order", headers: tenant })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST", url: "/v2/charges/authorize", headers: writeHeaders("bad-v2"), payload: { invalid: true },
    })).statusCode).toBe(400);
  });

  it("captures actual cycle units on return, capped at the authorization", async () => {
    const stack = await boot();
    app = stack.app;
    const auth = await app.inject({
      method: "POST", url: "/charges/authorize", headers: writeHeaders("authorize-1"),
      payload: { orderId: "order-1", amount: 5_260 },
    });
    expect(auth.statusCode).toBe(200);
    await stack.deps.bus.deliver(makeEnvelope({
      topic: "wash.completed", tenantId: "op1", occurredAt: 10, payload: { orderId: "order-1", washerId: "A1", completedAt: 10, cycleUnits: 80 },
    }));
    await stack.deps.bus.deliver(makeEnvelope({
      topic: "order.returned", tenantId: "op1", occurredAt: 20, payload: { orderId: "order-1", podId: "pod-1", habitatId: "hab01", returnedAt: 20, orbitsElapsed: 0 },
    }));
    expect(stack.captured).toEqual([{ paymentRef: "pay-order-1", amount: 5_140 }]);
    expect(stack.deps.bus.ofTopic("charge.captured")).toHaveLength(1);
    const ledger = await app.inject({ method: "GET", url: "/ledger?orderId=order-1", headers: tenant });
    expect((ledger.json() as Array<{ kind: string; amount: number }>).map(({ kind, amount }) => [kind, amount])).toEqual([
      ["authorize", 5_260],
      ["capture", 5_140],
    ]);
  });

  it("deduplicates webhooks and refunds an authorization through capture", async () => {
    const stack = await boot();
    app = stack.app;
    await app.inject({
      method: "POST", url: "/charges/authorize", headers: writeHeaders("authorize-2"),
      payload: { orderId: "order-2", amount: 5_260 },
    });
    const refund = await app.inject({ method: "POST", url: "/charges/order-2/refund", headers: writeHeaders("refund-2") });
    expect(refund.statusCode).toBe(200);
    expect(stack.captured).toEqual([{ paymentRef: "pay-order-2", amount: 5_260 }]);
    expect(stack.refunded).toEqual([{ paymentRef: "pay-order-2", amount: 5_260 }]);
    const webhook = {
      id: "webhook-2", paymentRef: "pay-order-2", orderId: "order-2",
      event: "refunded" as const, amount: 5_260, currency: "USD", atMs: 30,
    };
    const first = await app.inject({ method: "POST", url: "/callbacks/payments", headers: { "x-sudsnik-tenant": "system" }, payload: webhook });
    const duplicate = await app.inject({ method: "POST", url: "/callbacks/payments", headers: { "x-sudsnik-tenant": "system" }, payload: webhook });
    expect(first.json()).toEqual({ accepted: true, duplicate: false });
    expect(duplicate.json()).toEqual({ accepted: true, duplicate: true });
    expect(stack.deps.bus.ofTopic("refund.issued")).toHaveLength(1);
    const ledger = await app.inject({ method: "GET", url: "/ledger?orderId=order-2", headers: tenant });
    expect((ledger.json() as Array<{ kind: string; amount: number }>).map(({ kind, amount }) => [kind, amount])).toEqual([
      ["authorize", 5_260],
      ["refund", -5_260],
    ]);
  });

  it("records a captured webhook once, even when the callback is delivered twice", async () => {
    const stack = await boot();
    app = stack.app;
    await app.inject({
      method: "POST", url: "/charges/authorize", headers: writeHeaders("authorize-webhook"),
      payload: { orderId: "webhook-order", amount: 4_900 },
    });
    const webhook = {
      id: "captured-webhook", paymentRef: "pay-webhook-order", orderId: "webhook-order",
      event: "captured" as const, amount: 4_900, currency: "USD", atMs: 30,
    };
    const first = await app.inject({ method: "POST", url: "/callbacks/payments", headers: { "x-sudsnik-tenant": "system" }, payload: webhook });
    const duplicate = await app.inject({ method: "POST", url: "/callbacks/payments", headers: { "x-sudsnik-tenant": "system" }, payload: webhook });
    expect(first.json()).toEqual({ accepted: true, duplicate: false });
    expect(duplicate.json()).toEqual({ accepted: true, duplicate: true });
    const ledger = await app.inject({ method: "GET", url: "/ledger?orderId=webhook-order", headers: tenant });
    expect((ledger.json() as Array<{ kind: string }>).map(({ kind }) => kind)).toEqual(["authorize", "capture"]);
  });

  it("authorizes once per order regardless of request idempotency key", async () => {
    const stack = await boot();
    app = stack.app;
    let calls = 0;
    stack.deps.clients.payments.authorize = async (request, ctx) => {
      calls++;
      stack.authorizeKeys.push(ctx.idempotencyKey ?? "");
      return {
        ok: true,
        value: { paymentRef: `pay-${request.orderId}`, state: "authorized", amount: request.amount, currency: request.currency },
      };
    };
    const first = await app.inject({
      method: "POST", url: "/charges/authorize", headers: writeHeaders("key-one"),
      payload: { orderId: "A1", amount: 4_900 },
    });
    const second = await app.inject({
      method: "POST", url: "/charges/authorize", headers: writeHeaders("key-two"),
      payload: { orderId: "A1", amount: 4_900 },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(calls).toBe(1);
    expect(stack.authorizeKeys).toEqual(["A1"]);
  });

  it("passes the caller's idempotency key through and retries a transient authorization", async () => {
    const stack = await boot();
    app = stack.app;
    let attempts = 0;
    stack.deps.clients.payments.authorize = async (request, ctx) => {
      stack.authorizeKeys.push(ctx.idempotencyKey ?? "");
      attempts++;
      if (attempts === 1) return err(sudsnikError("TIMEOUT", "transient payment timeout"));
      return {
        ok: true,
        value: { paymentRef: `pay-${request.orderId}`, state: "authorized", amount: request.amount, currency: request.currency },
      };
    };
    const first = await app.inject({
      method: "POST", url: "/charges/authorize", headers: writeHeaders("A5"),
      payload: { orderId: "A5", amount: 5_260 },
    });
    expect(first.statusCode).toBe(504);
    const retry = await app.inject({
      method: "POST", url: "/charges/authorize", headers: writeHeaders("A5"),
      payload: { orderId: "A5", amount: 5_260 },
    });
    expect(retry.statusCode).toBe(200);
    expect(stack.authorizeKeys).toEqual(["A5", "A5"]);
  });

  it("keeps the hollow variant healthy while returning 501 for contract routes", async () => {
    const deps = fakeDeps("00000000c0ffee00", "billing", { handlersDir });
    app = await createHollow(deps) as App;
    expect((await app.inject("/ready")).statusCode).toBe(200);
    const response = await app.inject({
      method: "POST",
      url: "/charges/authorize",
      headers: writeHeaders("hollow"),
      payload: { orderId: "hollow-order", amount: 1 },
    });
    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({ code: "UNAVAILABLE", message: "billing is hollow", retryable: true });
    expect(deps.bus.published).toHaveLength(0);
  });
});
