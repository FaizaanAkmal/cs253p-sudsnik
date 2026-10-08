import { CANCELLABLE_STATES, type Order } from "@sudsnik/contracts/services/orders";
import type { Ctx } from "@sudsnik/contracts";
import { err, ok, sudsnikError, type Result } from "@sudsnik/kernel";
import { OrdersService, COMPENSATION, ORIGIN, notFound } from "../../core/OrdersService.js";

export class CancelOrdersService extends OrdersService {
  async cancel(orderId: string, reason: string, ctx: Ctx): Promise<Result<Order>> {
    const cancelled = this.inTransaction((): Result<{ order: Order; compensations: string[] }> => {
      const order = this.find(ctx.tenantId, orderId);
      if (!order) return err(notFound(orderId));
      if (!CANCELLABLE_STATES.includes(order.state)) return err(sudsnikError("CONFLICT", `order ${orderId} cannot be cancelled from ${order.state}`));
      const compensations = this.cancelInPlace(order, reason, ORIGIN.customer, { correlationId: ctx.correlationId });
      return ok({ order, compensations });
    });
    if (!cancelled.ok) return cancelled;
    if (cancelled.value.compensations.includes(COMPENSATION.refund)) await this.refundFor(cancelled.value.order, ctx.correlationId);
    return ok(cancelled.value.order);
  }
}
