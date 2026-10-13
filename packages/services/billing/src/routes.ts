import { IdSchema, IdempotencyHeaders } from "@sudsnik/contracts";
import { routes } from "@sudsnik/contracts/services/billing";
import { sendResult, type App } from "@sudsnik/infra-http";
import type { BillingRuntime } from "./runtime.js";
import { z } from "zod";

const OrderParams = z.object({ orderId: IdSchema });

export function registerRoutes(app: App, service: BillingRuntime): void {
  const quote = routes.quote;
  for (const path of versioned(quote.path)) app.route({
    method: quote.method,
    url: path,
    schema: { params: OrderParams, response: { 200: quote.response } },
    handler: async (req, reply) => sendResult(reply, await service.quote(req.params.orderId, req.ctx)),
  });

  const authorize = routes.authorize;
  for (const path of versioned(authorize.path)) app.route({
    method: authorize.method,
    url: path,
    schema: { headers: IdempotencyHeaders, body: authorize.body, response: { 200: authorize.response } },
    handler: async (req, reply) => sendResult(reply, await service.authorize(req.body.orderId, req.body.amount, req.ctx)),
  });

  const capture = routes.capture;
  for (const path of versioned(capture.path)) app.route({
    method: capture.method,
    url: path,
    schema: { headers: IdempotencyHeaders, params: OrderParams, response: { 200: capture.response } },
    handler: async (req, reply) => sendResult(reply, await service.capture(req.params.orderId, req.ctx)),
  });

  const refund = routes.refund;
  for (const path of versioned(refund.path)) app.route({
    method: refund.method,
    url: path,
    schema: { headers: IdempotencyHeaders, params: OrderParams, response: { 200: refund.response } },
    handler: async (req, reply) => sendResult(reply, await service.refund(req.params.orderId, req.ctx)),
  });

  const ledger = routes.ledger;
  for (const path of versioned(ledger.path)) app.route({
    method: ledger.method,
    url: path,
    schema: { querystring: ledger.query, response: { 200: ledger.response } },
    handler: async (req, reply) => sendResult(reply, await service.ledger(req.query, req.ctx)),
  });

  const paymentsWebhook = routes.paymentsWebhook;
  for (const path of versioned(paymentsWebhook.path)) app.route({
    method: paymentsWebhook.method,
    url: path,
    schema: { body: paymentsWebhook.body, response: { 200: paymentsWebhook.response } },
    handler: async (req, reply) => sendResult(reply, await service.webhook(req.body, req.ctx)),
  });
}

function versioned(path: string): string[] {
  return [path, `/v2${path}`];
}
