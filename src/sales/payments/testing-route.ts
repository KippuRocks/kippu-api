import type { FastifyInstance } from "fastify";
import type { Sales } from "../ports.js";
import { PaymentProviderError } from "./ports.js";
import type { TestPaymentProvider } from "./test-provider.js";

/** Where tests drive the deterministic payment provider over HTTP. Never mounted with a real one. */
export const PAYMENT_TESTING_PATH = "/v0/testing/payments/:checkoutId";

/** What a test makes of a hosted checkout: the buyer pays, a payment attempt fails, or it expires. */
export type TestPaymentOutcome = "paid" | "cancelled" | "expired";

interface Body {
  readonly outcome: TestPaymentOutcome;
  /** For `paid`: another amount than the checkout's, in minor units. */
  readonly amount?: number;
  /** Whether the provider's webhook follows, as Bloque would send it. Defaults to `true`. */
  readonly webhook?: boolean;
}

const bodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome"],
  properties: {
    outcome: { type: "string", enum: ["paid", "cancelled", "expired"] },
    amount: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    webhook: { type: "boolean" },
  },
} as const;

/**
 * A test-only route for end-to-end suites that run kippu-api as a separate
 * process (Ichiba's, `T-060-05`): it scripts the deterministic test provider —
 * a hosted checkout paid, cancelled by a failed attempt, or expired — and then
 * delivers the provider's signed webhook to Kippu's own webhook handling, as
 * the provider would. `:checkoutId` is the provider's checkout id: the last
 * segment of `Checkout.payment.url`.
 *
 * Mounted only by `createServer`, only in `development`, `test` and `staging`,
 * and only when the test provider is in use (`KIPPU_PAYMENTS_PROVIDER=test`, or
 * no provider named and no Bloque credentials outside `staging`): with Bloque, or
 * in `production`, the path does not exist (404).
 */
export function registerPaymentTestingRoute(
  app: FastifyInstance,
  provider: TestPaymentProvider,
  sales: Pick<Sales, "paymentWebhook">,
): void {
  app.post<{ Params: { checkoutId: string }; Body: Body }>(
    PAYMENT_TESTING_PATH,
    { schema: { body: bodySchema } },
    async (request, reply) => {
      const { checkoutId } = request.params;
      const { outcome, amount, webhook = true } = request.body;
      try {
        await provider.retrieve(checkoutId);
      } catch (error) {
        if (error instanceof PaymentProviderError) {
          return reply.code(404).send({ error: "no such hosted checkout" });
        }
        throw error;
      }
      let checkout: Awaited<ReturnType<TestPaymentProvider["retrieve"]>>;
      try {
        checkout =
          outcome === "paid"
            ? provider.pay(checkoutId, amount === undefined ? {} : { amount })
            : outcome === "cancelled"
              ? provider.failPayment(checkoutId)
              : provider.expire(checkoutId);
      } catch (error) {
        return reply.code(409).send({ error: (error as Error).message });
      }
      if (webhook) {
        const { rawBody, signature } = provider.webhook(checkoutId);
        await sales.paymentWebhook(request.id, rawBody, {
          [provider.webhookSignatureHeader]: signature,
        });
      }
      return reply.send({
        checkout: {
          id: checkout.id,
          status: checkout.status,
          amount: checkout.amount,
          asset: checkout.asset,
        },
        webhook: webhook ? "delivered" : "skipped",
      });
    },
  );
}
