import { describe, expect, it } from "vitest";
import { loadPaymentsConfig, PaymentsConfigError } from "../../../src/sales/payments/config.js";
import { paymentProviderFor } from "../../../src/sales/payments/provider.js";

const bloqueCredentials = {
  KIPPU_PUBLIC_URL: "https://api.kippu.example",
  KIPPU_BLOQUE_PAYMENTS_MODE: "sandbox",
  KIPPU_BLOQUE_PAYMENTS_SECRET_KEY: "sk_test_placeholder",
  KIPPU_BLOQUE_PAYMENTS_WEBHOOK_SECRET: "whsec_placeholder",
};

const bloque = { ...bloqueCredentials, KIPPU_PAYMENTS_PROVIDER: "bloque" };

const bloqueProduction = {
  ...bloqueCredentials,
  KIPPU_BLOQUE_PAYMENTS_MODE: "production",
  KIPPU_BLOQUE_PAYMENTS_SECRET_KEY: "sk_live_placeholder",
};

describe("payments configuration", () => {
  it("in development and test, with no provider named: the test provider, or Bloque when its credentials are set", () => {
    expect(loadPaymentsConfig("development", bloqueCredentials)).toMatchObject({
      provider: "bloque",
    });
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
  });

  it("needs KIPPU_PAYMENTS_PROVIDER in staging and production, with no default", () => {
    expect(() => loadPaymentsConfig("staging", {})).toThrow(/needs KIPPU_PAYMENTS_PROVIDER/);
    expect(() => loadPaymentsConfig("staging", bloqueCredentials)).toThrow(
      /needs KIPPU_PAYMENTS_PROVIDER/,
    );
    expect(() => loadPaymentsConfig("production", bloqueProduction)).toThrow(
      /needs KIPPU_PAYMENTS_PROVIDER: bloque/,
    );
    expect(() => loadPaymentsConfig("staging", { KIPPU_PAYMENTS_PROVIDER: "stripe" })).toThrow(
      /must be test or bloque/,
    );
  });

  it("allows the test provider in development, test and staging", () => {
    for (const environment of ["development", "test", "staging"] as const) {
      expect(loadPaymentsConfig(environment, { KIPPU_PAYMENTS_PROVIDER: "test" })).toEqual({
        provider: "test",
        publicUrl: "http://localhost:8080",
      });
    }
    expect(
      loadPaymentsConfig("staging", {
        KIPPU_PAYMENTS_PROVIDER: "test",
        KIPPU_PUBLIC_URL: "https://api.e2e.kippu.example",
      }),
    ).toEqual({ provider: "test", publicUrl: "https://api.e2e.kippu.example" });
  });

  it("refuses the test provider in production, and whenever a Bloque credential is set", () => {
    expect(() => loadPaymentsConfig("production", { KIPPU_PAYMENTS_PROVIDER: "test" })).toThrow(
      /refused in production/,
    );
    for (const environment of ["development", "test", "staging"] as const) {
      expect(() =>
        loadPaymentsConfig(environment, { ...bloqueCredentials, KIPPU_PAYMENTS_PROVIDER: "test" }),
      ).toThrow(/never both active/);
      expect(() =>
        loadPaymentsConfig(environment, {
          KIPPU_PAYMENTS_PROVIDER: "test",
          KIPPU_BLOQUE_PAYMENTS_SECRET_KEY: "sk_test_placeholder",
        }),
      ).toThrow(/KIPPU_BLOQUE_PAYMENTS_SECRET_KEY/);
    }
  });

  it("production uses Bloque, named, with its credentials", () => {
    expect(
      loadPaymentsConfig("production", { ...bloqueProduction, KIPPU_PAYMENTS_PROVIDER: "bloque" }),
    ).toMatchObject({ provider: "bloque", bloque: { mode: "production" } });
    expect(() =>
      loadPaymentsConfig("production", {
        KIPPU_PAYMENTS_PROVIDER: "bloque",
        KIPPU_PUBLIC_URL: "https://api.kippu.example",
      }),
    ).toThrow(/Bloque payments need/);
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
      loadPaymentsConfig("staging", {
        ...bloque,
        KIPPU_BLOQUE_PAYMENTS_SECRET_KEY: "sk_live_placeholder",
      }),
    ).toThrow(/sk_test_/);
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
