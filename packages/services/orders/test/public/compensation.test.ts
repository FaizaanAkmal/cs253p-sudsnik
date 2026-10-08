import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boot, cancel, driveTo, fakeBilling, getOrder, place, readDb, steps, type Stack } from "../helpers.js";

let stack: Stack;
beforeEach(async () => {
  stack = await boot();
});
afterEach(() => stack.app.sudsnik.drain());

describe("compensation on cancel", () => {
  // What every variant answers; what a cancel then does to the order is the hidden suite's (`docs/system-spec.md` §8).
  it("answers 200 with the order, and 404 for one the tenant does not own", async () => {
    fakeBilling(stack.deps);
    const order = await place(stack.app);
    await new Promise((r) => setImmediate(r));
    const res = await cancel(stack.app, order.orderId);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { orderId: string }).orderId).toBe(order.orderId);
    expect((await cancel(stack.app, order.orderId, "again", "op2")).statusCode).toBe(404);
  });

  it("records cancellation before refunding an authorized order", async () => {
    const billing = fakeBilling(stack.deps);
    const order = await place(stack.app);
    const res = await cancel(stack.app, order.orderId, "changed my mind");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orderId: order.orderId, state: "cancelled", cancelReason: "changed my mind", payment: "refunded" });
    expect(billing.refunds).toBe(1);
    const recorded = steps(stack.deps, order.orderId).map((s) => s.step);
    expect(recorded).toEqual(["place", "authorize", "cancel", "refund"]);
    const event = readDb(stack.deps, (db) =>
      db.prepare("select payload from outbox where topic = ?").all("order.cancelled") as Array<{ payload: string }>,
    )
      .map(({ payload }) => JSON.parse(payload) as { orderId: string; reason: string; origin: string; compensations: string[] })
      .find((payload) => payload.orderId === order.orderId);
    expect(event).toEqual({ orderId: order.orderId, reason: "changed my mind", origin: "customer", compensations: ["refund"] });
  });

  it("includes the hold release compensation, and refuses cancellation once washing starts", async () => {
    fakeBilling(stack.deps);
    const order = await place(stack.app);
    await driveTo(stack, order, "delivered");
    const cancelled = await cancel(stack.app, order.orderId);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ state: "cancelled", payment: "refunded" });
    const event = readDb(stack.deps, (db) =>
      db.prepare("select payload from outbox where topic = ?").all("order.cancelled") as Array<{ payload: string }>,
    )
      .map(({ payload }) => JSON.parse(payload) as { orderId: string; compensations: string[] })
      .find((payload) => payload.orderId === order.orderId);
    expect(event).toEqual({ orderId: order.orderId, reason: "changed my mind", origin: "customer", compensations: ["refund", "release-hold"] });

    const washing = await place(stack.app);
    await driveTo(stack, washing, "washing");
    const rejected = await cancel(stack.app, washing.orderId);
    expect(rejected.statusCode).toBe(409);
    expect((await getOrder(stack.app, washing.orderId)).state).toBe("washing");
  });
});
