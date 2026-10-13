import { IdSchema, IdempotencyHeaders } from "@sudsnik/contracts";
import { routes } from "@sudsnik/contracts/services/billing";
import { sendResult, type App } from "@sudsnik/infra-http";
import type { BillingRuntime } from "./runtime.js";
import { z } from "zod";

const OrderParams = z.object({ orderId: IdSchema });

export function registerRoutes(app: App, service: BillingRuntime): void {
  const quote = routes.quote;
  app.route({
    method: quote.method,
    url: quote.path,
    schema: { params: OrderParams, response: { 200: quote.response } },
    handler: async (req, reply) => sendResult(reply, await service.quote(req.params.orderId, req.ctx)),
  });

  const authorize = routes.authorize;
  app.route({
    method: authorize.method,
    url: authorize.path,
    schema: { headers: IdempotencyHeaders, body: authorize.body, response: { 200: authorize.response } },
    handler: async (req, reply) => sendResult(reply, await service.authorize(req.body.orderId, req.body.amount, req.ctx)),
  });

  const capture = routes.capture;
  app.route({
    method: capture.method,
    url: capture.path,
    schema: { headers: IdempotencyHeaders, params: OrderParams, response: { 200: capture.response } },
    handler: async (req, reply) => sendResult(reply, await service.capture(req.params.orderId, req.ctx)),
  });

  const refund = routes.refund;
  app.route({
    method: refund.method,
    url: refund.path,
    schema: { headers: IdempotencyHeaders, params: OrderParams, response: { 200: refund.response } },
    handler: async (req, reply) => sendResult(reply, await service.refund(req.params.orderId, req.ctx)),
  });

  const ledger = routes.ledger;
  app.route({
    method: ledger.method,
    url: ledger.path,
    schema: { querystring: ledger.query, response: { 200: ledger.response } },
    handler: async (req, reply) => sendResult(reply, await service.ledger(req.query, req.ctx)),
  });

  const paymentsWebhook = routes.paymentsWebhook;
  app.route({
    method: paymentsWebhook.method,
    url: paymentsWebhook.path,
    schema: { body: paymentsWebhook.body, response: { 200: paymentsWebhook.response } },
    handler: async (req, reply) => sendResult(reply, service.webhook(req.body, req.ctx)),
  });
}
