import {
  type ASSETS,
  Bloque,
  type Checkout,
  type CheckoutParams,
  type CheckoutStatus,
} from "@bloque/payments";
import {
  type CreateHostedCheckout,
  type HostedCheckout,
  type HostedCheckoutStatus,
  PAYMENT_METHODS,
  type PaymentProvider,
  PaymentProviderError,
} from "./ports.js";
import { HOLD_METADATA_KEY, webhookReferences } from "./webhook-references.js";

/** The assets `@bloque/payments` 0.2.1 accepts for a checkout. */
const BLOQUE_ASSETS: readonly ASSETS[] = ["COPM/2", "DUSD/6", "COP/2", "USD/6"];

/** What the adapter uses of `@bloque/payments`' client: replaced by a mock in tests. */
export interface BloquePaymentsClient {
  readonly checkout: {
    create(params: CheckoutParams): Promise<Checkout>;
    retrieve(checkoutId: string): Promise<Checkout>;
    cancel(paymentUrn: string): Promise<Checkout>;
  };
  readonly webhooks: {
    verify(body: string, signature: string, options: { secret: string }): boolean;
  };
}

/** The credentials a Bloque payments adapter needs: environment configuration, never code. */
export interface BloquePaymentsConfig {
  readonly mode: "sandbox" | "production";
  readonly secretKey: string;
  readonly webhookSecret: string;
}

export interface BloquePaymentProviderOptions {
  readonly client: BloquePaymentsClient;
  /** The secret Bloque signs webhooks with (HMAC-SHA256). */
  readonly webhookSecret: string;
}

/** The `@bloque/payments` client for real credentials. Constructing it makes no request. */
export function bloquePaymentsClient(config: BloquePaymentsConfig): BloquePaymentsClient {
  return new Bloque({
    mode: config.mode,
    secretKey: config.secretKey,
    webhookSecret: config.webhookSecret,
  });
}

function statusOf(status: CheckoutStatus): HostedCheckoutStatus {
  switch (status) {
    case "created":
    case "pending":
      return "open";
    // `deposited`: paid, and the funds moved on.
    case "paid":
    case "deposited":
      return "paid";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
    default:
      // The server's status enum may grow before the SDK's type does: never read it as paid.
      throw new PaymentProviderError(
        `Bloque payments: unknown checkout status "${String(status)}"`,
      );
  }
}

function hostedCheckoutOf(checkout: Checkout): HostedCheckout {
  const hold = checkout.metadata?.[HOLD_METADATA_KEY];
  return {
    id: checkout.id,
    url: checkout.url,
    status: statusOf(checkout.status),
    amount: checkout.amount_total,
    asset: checkout.asset,
    holdId: typeof hold === "string" ? hold : null,
    expiresAt: checkout.expires_at === null ? null : new Date(checkout.expires_at),
  };
}

async function provider<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new PaymentProviderError(`Bloque payments: ${what} failed`, { cause: error });
  }
}

/**
 * The payment provider over `@bloque/payments`' hosted checkout (`T-022-01`;
 * `F-022` plan §5.4).
 *
 * A checkout is one item — the ticket — at the hold's amount, naming the hold in
 * its metadata and expiring with it. It offers card and PSE; cash settles long
 * after a hold lapses. No payer details are passed: Bloque's page collects what
 * it needs. `@bloque/payments` has no authorise/capture split and no refund call.
 */
export function createBloquePaymentProvider(
  options: BloquePaymentProviderOptions,
): PaymentProvider {
  const { client, webhookSecret } = options;
  if (webhookSecret === "") {
    throw new PaymentProviderError("Bloque payments: a webhook secret is required");
  }

  return {
    // As `@bloque/payments`' README verifies it; 0.2.1 names no header in its types.
    webhookSignatureHeader: "x-bloque-signature",

    async createCheckout(input: CreateHostedCheckout) {
      if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
        throw new PaymentProviderError(
          "an amount is a non-negative integer in the asset's smallest unit",
        );
      }
      const asset = BLOQUE_ASSETS.find((candidate) => candidate === input.asset);
      if (asset === undefined) {
        throw new PaymentProviderError(`Bloque payments do not take ${input.asset}`);
      }
      const created = await provider("creating a checkout", () =>
        client.checkout.create({
          name: input.description,
          items: [{ name: input.description, amount: input.amount, quantity: 1 }],
          asset,
          payment_type: "shopping_cart",
          payment_methods: [...PAYMENT_METHODS],
          metadata: { [HOLD_METADATA_KEY]: input.holdId },
          expires_at: input.expiresAt.toISOString(),
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          webhook_url: input.webhookUrl,
          // A paid link can never be paid again; a failed attempt ends it (plan §5.4).
          single_use: true,
        }),
      );
      return hostedCheckoutOf(created);
    },

    async retrieve(id) {
      return hostedCheckoutOf(
        await provider("retrieving a checkout", () => client.checkout.retrieve(id)),
      );
    },

    async cancel(id) {
      // Bloque cancels by payment URN, which retrieving the checkout names.
      const current = await provider("retrieving a checkout", () => client.checkout.retrieve(id));
      if (statusOf(current.status) !== "open") {
        return hostedCheckoutOf(current);
      }
      await provider("cancelling a checkout", () => client.checkout.cancel(current.urn));
      return hostedCheckoutOf(
        await provider("retrieving a checkout", () => client.checkout.retrieve(id)),
      );
    },

    verifyWebhook(rawBody, signature) {
      if (signature === undefined || signature === "") return null;
      if (!client.webhooks.verify(rawBody, signature, { secret: webhookSecret })) return null;
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return null;
      }
      return webhookReferences(payload);
    },
  };
}
