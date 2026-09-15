import { describe, expect, it } from "vitest";
import { PaymentProviderError } from "../../../src/sales/payments/ports.js";
import { createTestPaymentProvider } from "../../../src/sales/payments/test-provider.js";

const input = (expiresAt: Date) => ({
  holdId: "0b7c1d4e-2f3a-4b5c-8d9e-0f1a2b3c4d5e",
  description: "Stalls",
  amount: 12_000_000,
  asset: "COP/2",
  expiresAt,
  successUrl: "https://ichiba.kippu.example/checkout/done",
  cancelUrl: "https://ichiba.kippu.example/checkout/cancelled",
  webhookUrl: "https://api.kippu.example/webhooks/payments/bloque",
});

describe("the deterministic test payment provider", () => {
  it("creates numbered checkouts for a hold, open until paid", async () => {
    const provider = createTestPaymentProvider();
    const expiresAt = new Date(Date.now() + 600_000);
    const first = await provider.createCheckout(input(expiresAt));
    const second = await provider.createCheckout(input(expiresAt));

    expect(first).toEqual({
      id: "test-checkout-1",
      url: "https://payments.test.invalid/checkout/test-checkout-1",
      status: "open",
      amount: 12_000_000,
      asset: "COP/2",
      holdId: "0b7c1d4e-2f3a-4b5c-8d9e-0f1a2b3c4d5e",
      expiresAt,
    });
    expect(second.id).toBe("test-checkout-2");

    provider.pay(first.id);
    expect(await provider.retrieve(first.id)).toMatchObject({ status: "paid", amount: 12_000_000 });
    expect(provider.pay(second.id, { amount: 1 })).toMatchObject({ status: "paid", amount: 1 });
    expect(provider.checkouts().map(({ status }) => status)).toEqual(["paid", "paid"]);
  });

  it("expires a checkout at its expiry, by its clock, or when told to", async () => {
    let clock = new Date("2026-09-14T20:00:00Z");
    const provider = createTestPaymentProvider({ now: () => clock });
    const lapsing = await provider.createCheckout(input(new Date("2026-09-14T20:10:00Z")));
    const told = await provider.createCheckout(input(new Date("2026-09-14T21:00:00Z")));

    expect((await provider.retrieve(lapsing.id)).status).toBe("open");
    clock = new Date("2026-09-14T20:10:00Z");
    expect((await provider.retrieve(lapsing.id)).status).toBe("expired");
    expect(() => provider.pay(lapsing.id)).toThrow(/expired/);

    provider.expire(told.id);
    expect((await provider.retrieve(told.id)).status).toBe("expired");
  });

  it("cancels an open checkout, never a paid one — even one paid just as it cancels", async () => {
    const provider = createTestPaymentProvider();
    const expiresAt = new Date(Date.now() + 600_000);
    const unpaid = await provider.createCheckout(input(expiresAt));
    const paid = await provider.createCheckout(input(expiresAt));
    const racing = await provider.createCheckout(input(expiresAt));
    provider.pay(paid.id);
    provider.payBeforeCancel(racing.id);

    expect((await provider.cancel(unpaid.id)).status).toBe("cancelled");
    expect((await provider.cancel(paid.id)).status).toBe("paid");
    expect((await provider.cancel(racing.id)).status).toBe("paid");
    expect(() => provider.pay(unpaid.id)).toThrow(/cancelled/);
  });

  it("fails the next call it is told to fail, once", async () => {
    const provider = createTestPaymentProvider();
    const expiresAt = new Date(Date.now() + 600_000);
    provider.failNext("createCheckout");
    await expect(provider.createCheckout(input(expiresAt))).rejects.toBeInstanceOf(
      PaymentProviderError,
    );
    const created = await provider.createCheckout(input(expiresAt));

    provider.failNext("retrieve");
    await expect(provider.retrieve(created.id)).rejects.toBeInstanceOf(PaymentProviderError);
    provider.failNext("cancel");
    await expect(provider.cancel(created.id)).rejects.toBeInstanceOf(PaymentProviderError);
    expect((await provider.retrieve(created.id)).status).toBe("open");
    await expect(provider.retrieve("test-checkout-99")).rejects.toBeInstanceOf(
      PaymentProviderError,
    );
  });

  it("signs webhooks, and verifies only its own signature over the raw body", async () => {
    const provider = createTestPaymentProvider();
    const created = await provider.createCheckout(input(new Date(Date.now() + 600_000)));
    provider.pay(created.id);

    const webhook = provider.webhook(created.id);
    expect(provider.verifyWebhook(webhook.rawBody, webhook.signature)).toEqual({
      checkoutIds: [created.id],
      holdIds: ["0b7c1d4e-2f3a-4b5c-8d9e-0f1a2b3c4d5e"],
    });

    const forged = provider.forgedWebhook(created.id);
    expect(provider.verifyWebhook(forged.rawBody, forged.signature)).toBeNull();
    expect(provider.verifyWebhook(`${webhook.rawBody} `, webhook.signature)).toBeNull();
    expect(provider.verifyWebhook(webhook.rawBody, undefined)).toBeNull();
  });

  it("refuses an amount that is not a whole number of the asset's smallest unit", async () => {
    const provider = createTestPaymentProvider();
    const expiresAt = new Date(Date.now() + 600_000);
    await expect(provider.createCheckout({ ...input(expiresAt), amount: 1.5 })).rejects.toThrow(
      PaymentProviderError,
    );
    await expect(provider.createCheckout({ ...input(expiresAt), amount: -1 })).rejects.toThrow(
      PaymentProviderError,
    );
  });
});
