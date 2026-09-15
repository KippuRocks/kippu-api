import { describe, expect, it } from "vitest";
import { loadPaymentsConfig, PaymentsConfigError } from "../../../src/sales/payments/config.js";
import { paymentProviderFor } from "../../../src/sales/payments/provider.js";

const bloque = {
  KIPPU_PUBLIC_URL: "https://api.kippu.example",
  KIPPU_BLOQUE_PAYMENTS_MODE: "sandbox",
  KIPPU_BLOQUE_PAYMENTS_SECRET_KEY: "sk_test_placeholder",
  KIPPU_BLOQUE_PAYMENTS_WEBHOOK_SECRET: "whsec_placeholder",
};

describe("payments configuration", () => {
  it("uses the test provider where the ledger is backend-memory and no credentials are set", () => {
    expect(loadPaymentsConfig("development", {})).toEqual({
      provider: "test",
      publicUrl: "http://localhost:8080",
    });
    expect(loadPaymentsConfig("test", { KIPPU_PUBLIC_URL: "https://api.kippu.example" })).toEqual({
      provider: "test",
      publicUrl: "https://api.kippu.example",
    });
    expect(() =>
      loadPaymentsConfig("test", { KIPPU_PUBLIC_URL: "https://api.kippu.example/v0" }),
    ).toThrow(/KIPPU_PUBLIC_URL/);
    expect(() => loadPaymentsConfig("staging", {})).toThrow(PaymentsConfigError);
    expect(() => loadPaymentsConfig("production", {})).toThrow(PaymentsConfigError);
  });

  it("reads Bloque's credentials from the environment, all three or none", () => {
    expect(loadPaymentsConfig("staging", bloque)).toEqual({
      provider: "bloque",
      publicUrl: "https://api.kippu.example",
      bloque: {
        mode: "sandbox",
        secretKey: "sk_test_placeholder",
        webhookSecret: "whsec_placeholder",
      },
    });
    expect(() =>
      loadPaymentsConfig("development", { ...bloque, KIPPU_BLOQUE_PAYMENTS_WEBHOOK_SECRET: "" }),
    ).toThrow(/KIPPU_BLOQUE_PAYMENTS_WEBHOOK_SECRET unset/);
    expect(() =>
      loadPaymentsConfig("development", { ...bloque, KIPPU_BLOQUE_PAYMENTS_MODE: "live" }),
    ).toThrow(PaymentsConfigError);
  });

  it("refuses a key of the other mode", () => {
    expect(() =>
      loadPaymentsConfig("production", { ...bloque, KIPPU_BLOQUE_PAYMENTS_MODE: "production" }),
    ).toThrow(/sk_live_/);
    expect(() =>
      loadPaymentsConfig("development", {
        ...bloque,
        KIPPU_BLOQUE_PAYMENTS_SECRET_KEY: "sk_live_placeholder",
      }),
    ).toThrow(/sk_test_/);
  });

  it("builds the provider a configuration names, without any request", () => {
    expect(() => loadPaymentsConfig("staging", { ...bloque, KIPPU_PUBLIC_URL: "" })).toThrow(
      /KIPPU_PUBLIC_URL is required/,
    );
    expect(paymentProviderFor(loadPaymentsConfig("test", {}))).toHaveProperty("pay");
    const provider = paymentProviderFor(loadPaymentsConfig("staging", bloque));
    expect(provider).not.toHaveProperty("pay");
    expect(provider.verifyWebhook("{}", "00")).toBeNull();
  });
});
