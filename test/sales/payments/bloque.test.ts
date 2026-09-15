import { createHmac } from "node:crypto";
import { APIError, Bloque, type Checkout, type CheckoutParams } from "@bloque/payments";
import { describe, expect, it } from "vitest";
import {
  type BloquePaymentsClient,
  bloquePaymentsClient,
  createBloquePaymentProvider,
} from "../../../src/sales/payments/bloque.js";
import { PaymentProviderError } from "../../../src/sales/payments/ports.js";

const WEBHOOK_SECRET = "whsec_test_only";
const HOLD = "0b7c1d4e-2f3a-4b5c-8d9e-0f1a2b3c4d5e";
const EXPIRES_AT = new Date("2026-09-14T20:10:00.000Z");

const input = {
  holdId: HOLD,
  description: "Stalls",
  amount: 12_000_000,
  asset: "COP/2",
  expiresAt: EXPIRES_AT,
  successUrl: "https://ichiba.kippu.example/checkout/done",
  cancelUrl: "https://ichiba.kippu.example/checkout/cancelled",
  webhookUrl: "https://api.kippu.example/webhooks/payments/bloque",
};

/** A checkout as `@bloque/payments` returns it. */
const bloqueCheckout = (overrides: Partial<Checkout> = {}): Checkout => ({
  id: "4f5e6d7c-link",
  urn: "did:bloque:payments:4f5e6d7c",
  object: "checkout",
  url: "https://pay.bloque.example/4f5e6d7c-link",
  status: "pending",
  payment_type: "shopping_cart",
  amount_total: 12_000_000,
  amount_subtotal: 12_000_000,
  asset: "COP/2",
  items: [{ name: "Stalls", amount: 12_000_000, quantity: 1 }],
  metadata: { kippu_hold: HOLD, payment_methods: ["card", "pse"] },
  created_at: "2026-09-14T20:00:00.000Z",
  updated_at: "2026-09-14T20:00:00.000Z",
  expires_at: EXPIRES_AT.toISOString(),
  ...overrides,
});

interface MockCalls {
  readonly created: CheckoutParams[];
  readonly retrieved: string[];
  readonly cancelled: string[];
}

/**
 * A mocked `@bloque/payments` client: no request leaves the process. Webhooks are
 * verified by the package's own HMAC verifier, which is local.
 */
function mockClient(states: Checkout[]): { client: BloquePaymentsClient; calls: MockCalls } {
  const calls: MockCalls = { created: [], retrieved: [], cancelled: [] };
  const queue = [...states];
  const next = () => {
    const state = queue.length > 1 ? queue.shift() : queue[0];
    if (state === undefined) throw new Error("no scripted state");
    return state;
  };
  const verifier = new Bloque({ mode: "sandbox", secretKey: "sk_test_never_used" }).webhooks;
  return {
    calls,
    client: {
      checkout: {
        create: async (params) => {
          calls.created.push(params);
          return next();
        },
        retrieve: async (id) => {
          calls.retrieved.push(id);
          return next();
        },
        cancel: async (urn) => {
          calls.cancelled.push(urn);
          return next();
        },
      },
      webhooks: { verify: (body, signature, options) => verifier.verify(body, signature, options) },
    },
  };
}

describe("the Bloque payment provider, over a mocked @bloque/payments", () => {
  it("creates a single-use hosted checkout for the hold: one item, card and PSE only, expiring with the hold, webhooks to Kippu, no payer details", async () => {
    const { client, calls } = mockClient([bloqueCheckout()]);
    const provider = createBloquePaymentProvider({ client, webhookSecret: WEBHOOK_SECRET });

    const created = await provider.createCheckout(input);

    expect(calls.created).toEqual([
      {
        name: "Stalls",
        items: [{ name: "Stalls", amount: 12_000_000, quantity: 1 }],
        asset: "COP/2",
        payment_type: "shopping_cart",
        payment_methods: ["card", "pse"],
        metadata: { kippu_hold: HOLD },
        expires_at: "2026-09-14T20:10:00.000Z",
        success_url: "https://ichiba.kippu.example/checkout/done",
        cancel_url: "https://ichiba.kippu.example/checkout/cancelled",
        webhook_url: "https://api.kippu.example/webhooks/payments/bloque",
        single_use: true,
      },
    ]);
    expect(calls.created[0]).not.toHaveProperty("payeer");
    expect(created).toEqual({
      id: "4f5e6d7c-link",
      url: "https://pay.bloque.example/4f5e6d7c-link",
      status: "open",
      amount: 12_000_000,
      asset: "COP/2",
      holdId: HOLD,
      expiresAt: EXPIRES_AT,
    });
  });

  it("reads Bloque's statuses: created and pending are open, paid and deposited are paid", async () => {
    const statuses = ["created", "pending", "paid", "deposited", "expired", "cancelled"] as const;
    const { client } = mockClient(statuses.map((status) => bloqueCheckout({ status })));
    const provider = createBloquePaymentProvider({ client, webhookSecret: WEBHOOK_SECRET });

    const read = [];
    for (const _ of statuses) read.push((await provider.retrieve("4f5e6d7c-link")).status);
    expect(read).toEqual(["open", "open", "paid", "paid", "expired", "cancelled"]);

    const unknown = mockClient([bloqueCheckout({ status: "refunded" as never })]);
    await expect(
      createBloquePaymentProvider({
        client: unknown.client,
        webhookSecret: WEBHOOK_SECRET,
      }).retrieve("4f5e6d7c-link"),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it("reports a checkout naming no hold with a null hold", async () => {
    const { client } = mockClient([bloqueCheckout({ metadata: {} })]);
    const provider = createBloquePaymentProvider({ client, webhookSecret: WEBHOOK_SECRET });
    expect((await provider.retrieve("4f5e6d7c-link")).holdId).toBeNull();
  });

  it("cancels an open checkout by its payment URN, and leaves a paid one alone", async () => {
    const open = mockClient([
      bloqueCheckout({ status: "pending" }),
      bloqueCheckout({ status: "cancelled" }),
    ]);
    const provider = createBloquePaymentProvider({
      client: open.client,
      webhookSecret: WEBHOOK_SECRET,
    });
    expect((await provider.cancel("4f5e6d7c-link")).status).toBe("cancelled");
    expect(open.calls.cancelled).toEqual(["did:bloque:payments:4f5e6d7c"]);

    const paid = mockClient([bloqueCheckout({ status: "paid" })]);
    const paidProvider = createBloquePaymentProvider({
      client: paid.client,
      webhookSecret: WEBHOOK_SECRET,
    });
    expect((await paidProvider.cancel("4f5e6d7c-link")).status).toBe("paid");
    expect(paid.calls.cancelled).toEqual([]);
  });

  it("verifies a webhook's HMAC-SHA256 signature over the raw body before reading it", () => {
    const { client } = mockClient([bloqueCheckout()]);
    const provider = createBloquePaymentProvider({ client, webhookSecret: WEBHOOK_SECRET });
    const rawBody = JSON.stringify({
      event: "payment.paid",
      payment: { urn: "did:bloque:payments:4f5e6d7c", url_id: "4f5e6d7c-link" },
      metadata: { kippu_hold: HOLD },
    });
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");

    expect(provider.verifyWebhook(rawBody, signature)).toEqual({
      checkoutIds: ["4f5e6d7c-link", "did:bloque:payments:4f5e6d7c"],
      holdIds: [HOLD],
    });
    const forged = createHmac("sha256", "another-secret").update(rawBody).digest("hex");
    expect(provider.verifyWebhook(rawBody, forged)).toBeNull();
    expect(provider.verifyWebhook(rawBody.replace("paid", "PAID"), signature)).toBeNull();
    expect(provider.verifyWebhook(rawBody, undefined)).toBeNull();
    const notJson = "not json";
    expect(
      provider.verifyWebhook(
        notJson,
        createHmac("sha256", WEBHOOK_SECRET).update(notJson).digest("hex"),
      ),
    ).toBeNull();
  });

  it("wraps Bloque's failures, and refuses what Bloque cannot take before calling it", async () => {
    const { client, calls } = mockClient([bloqueCheckout()]);
    client.checkout.create = async () => {
      throw new APIError("bad request", 400, "E_VALIDATION");
    };
    const provider = createBloquePaymentProvider({ client, webhookSecret: WEBHOOK_SECRET });

    const failure = await provider.createCheckout(input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PaymentProviderError);
    expect((failure as PaymentProviderError).cause).toBeInstanceOf(APIError);

    await expect(provider.createCheckout({ ...input, asset: "EUR/2" })).rejects.toThrow(/EUR\/2/);
    await expect(provider.createCheckout({ ...input, amount: 10.5 })).rejects.toThrow(
      PaymentProviderError,
    );
    expect(calls.created).toEqual([]);
    expect(() => createBloquePaymentProvider({ client, webhookSecret: "" })).toThrow(
      PaymentProviderError,
    );
  });
});

/**
 * Against Bloque's sandbox, once Pablo supplies credentials. Skipped in CI and
 * wherever they are unset: agents create no Bloque resource and make no live call.
 */
const sandbox = {
  secretKey: process.env.KIPPU_TEST_BLOQUE_PAYMENTS_SECRET_KEY,
  webhookSecret: process.env.KIPPU_TEST_BLOQUE_PAYMENTS_WEBHOOK_SECRET,
};

describe.runIf(sandbox.secretKey !== undefined && sandbox.webhookSecret !== undefined)(
  "the Bloque payment provider, against the sandbox",
  () => {
    it("creates, retrieves and cancels a hosted checkout", async () => {
      const config = {
        mode: "sandbox" as const,
        secretKey: sandbox.secretKey as string,
        webhookSecret: sandbox.webhookSecret as string,
      };
      const provider = createBloquePaymentProvider({
        client: bloquePaymentsClient(config),
        webhookSecret: config.webhookSecret,
      });
      const created = await provider.createCheckout({
        ...input,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      expect(created).toMatchObject({ status: "open", amount: input.amount, holdId: HOLD });
      expect((await provider.retrieve(created.id)).holdId).toBe(HOLD);
      expect((await provider.cancel(created.id)).status).toBe("cancelled");
    });
  },
);
