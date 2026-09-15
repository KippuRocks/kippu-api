import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type CreateHostedCheckout,
  type HostedCheckout,
  type PaymentProvider,
  PaymentProviderError,
} from "./ports.js";
import { HOLD_METADATA_KEY, webhookReferences } from "./webhook-references.js";

/** Marks a test provider, so wiring can tell it from a real one. */
const TEST_PROVIDER = Symbol("kippu.testPaymentProvider");

/** Whether `provider` is the deterministic test provider. */
export function isTestPaymentProvider(provider: object): provider is TestPaymentProvider {
  return TEST_PROVIDER in provider;
}

/** The operations a test can make fail. */
export type TestProviderOperation = "createCheckout" | "retrieve" | "cancel";

/** A webhook as the test provider would deliver it: the raw body and its signature. */
export interface TestWebhook {
  readonly rawBody: string;
  readonly signature: string;
}

/**
 * The deterministic test payment provider (`T-022-01`; `F-022` plan §5.4), used
 * by every test but the Bloque adapter's own, and by development.
 *
 * It holds checkouts in memory, numbered in creation order, and changes nothing
 * on its own but expiry, read from its clock. A test scripts the rest: the buyer
 * paying (for the right amount or not), the checkout expiring, a call failing,
 * a payment landing just as Kippu cancels, and signed or forged webhooks.
 */
export interface TestPaymentProvider extends PaymentProvider {
  readonly [TEST_PROVIDER]: true;
  /** Every checkout created, in order. */
  checkouts(): readonly HostedCheckout[];
  /** The buyer pays an open checkout — by default its amount. */
  pay(id: string, options?: { readonly amount?: number }): HostedCheckout;
  /** The buyer's payment attempt fails: a single-use checkout is cancelled by it (plan §5.4). */
  failPayment(id: string): HostedCheckout;
  /** An open checkout expires now, whatever its expiry. */
  expire(id: string): HostedCheckout;
  /** The next call of `operation` fails with a `PaymentProviderError`. */
  failNext(operation: TestProviderOperation): void;
  /** The next `cancel` of `id` finds the buyer has just paid it. */
  payBeforeCancel(id: string): void;
  /** A webhook reporting the checkout's current state, signed with the provider's secret. */
  webhook(id: string): TestWebhook;
  /** The same webhook, signed with another secret. */
  forgedWebhook(id: string): TestWebhook;
}

export interface TestPaymentProviderOptions {
  /** What checkout ids start with: `test-checkout` by default. Providers sharing a store need their own. */
  readonly prefix?: string;
  /** The secret webhooks are signed with. */
  readonly webhookSecret?: string;
  readonly now?: () => Date;
}

interface Stored {
  checkout: HostedCheckout;
}

const sign = (rawBody: string, secret: string): string =>
  createHmac("sha256", secret).update(rawBody).digest("hex");

export function createTestPaymentProvider(
  options: TestPaymentProviderOptions = {},
): TestPaymentProvider {
  const {
    webhookSecret = "test-webhook-secret",
    now = () => new Date(),
    prefix = "test-checkout",
  } = options;
  const stored = new Map<string, Stored>();
  const failures = new Set<TestProviderOperation>();
  const paysBeforeCancel = new Set<string>();
  let sequence = 0;

  const failIfScripted = (operation: TestProviderOperation) => {
    if (failures.delete(operation)) {
      throw new PaymentProviderError(`test provider: ${operation} failed, as scripted`);
    }
  };

  const find = (id: string): Stored => {
    const found = stored.get(id);
    if (found === undefined) {
      throw new PaymentProviderError(`test provider: no checkout ${id}`);
    }
    // Expiry is the only change the provider makes on its own.
    const { checkout } = found;
    if (checkout.status === "open" && checkout.expiresAt !== null && checkout.expiresAt <= now()) {
      found.checkout = { ...checkout, status: "expired" };
    }
    return found;
  };

  const open = (id: string): Stored => {
    const found = find(id);
    if (found.checkout.status !== "open") {
      throw new Error(`test provider: checkout ${id} is ${found.checkout.status}, not open`);
    }
    return found;
  };

  const markPaid = (found: Stored, amount: number) => {
    found.checkout = { ...found.checkout, status: "paid", amount };
  };

  const payload = (checkout: HostedCheckout) =>
    JSON.stringify({
      event: `checkout.${checkout.status}`,
      url_id: checkout.id,
      status: checkout.status,
      amount: checkout.amount,
      metadata: checkout.holdId === null ? {} : { [HOLD_METADATA_KEY]: checkout.holdId },
    });

  return {
    [TEST_PROVIDER]: true,
    webhookSignatureHeader: "x-test-signature",

    async createCheckout(input: CreateHostedCheckout) {
      failIfScripted("createCheckout");
      if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
        throw new PaymentProviderError(
          "an amount is a non-negative integer in the asset's smallest unit",
        );
      }
      sequence += 1;
      const id = `${prefix}-${sequence}`;
      const checkout: HostedCheckout = {
        id,
        url: `https://payments.test.invalid/checkout/${id}`,
        status: "open",
        amount: input.amount,
        asset: input.asset,
        holdId: input.holdId,
        expiresAt: input.expiresAt,
      };
      stored.set(id, { checkout });
      return checkout;
    },

    async retrieve(id) {
      failIfScripted("retrieve");
      return find(id).checkout;
    },

    async cancel(id) {
      failIfScripted("cancel");
      const found = find(id);
      if (paysBeforeCancel.delete(id) && found.checkout.status === "open") {
        markPaid(found, found.checkout.amount);
      }
      if (found.checkout.status === "open") {
        found.checkout = { ...found.checkout, status: "cancelled" };
      }
      return found.checkout;
    },

    verifyWebhook(rawBody, signature) {
      if (signature === undefined) return null;
      const expected = Buffer.from(sign(rawBody, webhookSecret));
      const given = Buffer.from(signature);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      try {
        return webhookReferences(JSON.parse(rawBody));
      } catch {
        return null;
      }
    },

    checkouts: () => [...stored.keys()].map((id) => find(id).checkout),

    pay(id, payment = {}) {
      const found = open(id);
      markPaid(found, payment.amount ?? found.checkout.amount);
      return found.checkout;
    },

    failPayment(id) {
      const found = open(id);
      found.checkout = { ...found.checkout, status: "cancelled" };
      return found.checkout;
    },

    expire(id) {
      const found = open(id);
      found.checkout = { ...found.checkout, status: "expired" };
      return found.checkout;
    },

    failNext: (operation) => {
      failures.add(operation);
    },

    payBeforeCancel: (id) => {
      paysBeforeCancel.add(id);
    },

    webhook(id) {
      const rawBody = payload(find(id).checkout);
      return { rawBody, signature: sign(rawBody, webhookSecret) };
    },

    forgedWebhook(id) {
      const rawBody = payload(find(id).checkout);
      return { rawBody, signature: sign(rawBody, `${webhookSecret}-forged`) };
    },
  };
}
