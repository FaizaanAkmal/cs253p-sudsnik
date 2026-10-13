import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractSuite } from "@sudsnik/contracts/testing/contractSuite";
import { routes } from "@sudsnik/contracts/services/billing";
import { createApp, handlersDir } from "../../src/index.js";

contractSuite(
  { describe, it, expect, beforeAll, afterAll },
  {
    service: "billing",
    routes,
    createApp,
    handlersDir,
    examples: {
      quote: { params: { orderId: "quote-order" } },
      authorize: { body: { orderId: "contract-order", amount: 1 } },
      capture: { params: { orderId: "contract-order" } },
      refund: { params: { orderId: "contract-order" } },
      ledger: { query: { orderId: "contract-order", limit: "10" } },
      paymentsWebhook: {
        body: {
          id: "contract-webhook",
          paymentRef: "pay-contract-order",
          orderId: "contract-order",
          event: "captured",
          amount: 1,
          currency: "USD",
          atMs: 1,
        },
      },
    },
    prepare(deps) {
      deps.clients.payments.authorize = async (req) => ({
        ok: true,
        value: { paymentRef: `pay-${req.orderId}`, state: "authorized", amount: req.amount, currency: req.currency },
      });
      deps.clients.payments.capture = async (paymentRef, amount) => ({
        ok: true,
        value: { paymentRef, state: "captured", amount: amount ?? 1, currency: "USD" },
      });
      deps.clients.payments.refund = async (paymentRef, amount) => ({
        ok: true,
        value: { paymentRef, state: "refunded", amount: amount ?? 1, currency: "USD" },
      });
    },
  },
);
