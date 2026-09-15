import { createMemoryBackend } from "@ticketto/backend-memory";
import { createProfileV0 } from "@ticketto/profile-v0";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createBloquePaymentProvider } from "../../src/sales/payments/bloque.js";
import { loadPaymentsConfig } from "../../src/sales/payments/config.js";
import { paymentProviderFor } from "../../src/sales/payments/provider.js";
import { registerPaymentTestingRoute } from "../../src/sales/payments/testing-route.js";
import { createDomainServices, createServer, type KippuServer } from "../../src/wiring.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { type EventsHarness, eventsHarness, randomId } from "../support/events.js";

const RETURN_URLS = {
  successUrl: "https://ichiba.kippu.example/checkout/paid",
  cancelUrl: "https://ichiba.kippu.example/checkout/cancelled",
};

const environment = (databaseUrl: string, ledgerEnvironment: string) => ({
  KIPPU_DATABASE_URL: databaseUrl,
  KIPPU_LOGIN_RP_ID: "login.kippu.example",
  KIPPU_LOGIN_ORIGINS: "https://ibento.login.kippu.example",
  KIPPU_HOLDER_RP_ID: "holder.kippu.example",
  KIPPU_LEDGER_ENVIRONMENT: ledgerEnvironment,
});

describeWithStore("the test-only payments route", () => {
  let database: TestDatabase;
  let harness: EventsHarness;
  let testing: FastifyInstance;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    harness = await eventsHarness();
    testing = Fastify();
    registerPaymentTestingRoute(testing, harness.payments, harness.sales);
    await testing.ready();
  });

  afterAll(async () => {
    await testing.close();
    await harness.close();
    await database.drop();
  });

  const serverWith = (wiring: Parameters<typeof createServer>[3] = {}): KippuServer =>
    createServer(loadConfig(environment(database.url, "development")), database.store, {}, wiring);

  const drive = (app: FastifyInstance, checkoutId: string, body: object) =>
    app.inject({ method: "POST", url: `/v0/testing/payments/${checkoutId}`, payload: body });

  it("is mounted in development with the test provider, and absent with Bloque's", async () => {
    const withTest = serverWith();
    const unknown = await drive(withTest.app, "test-checkout-404", { outcome: "paid" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "no such hosted checkout" });
    await withTest.close();

    const withBloque = serverWith({
      payments: {
        provider: createBloquePaymentProvider({
          client: {} as never,
          webhookSecret: "whsec_test_only",
        }),
        publicUrl: "https://api.kippu.example",
      },
    });
    const absent = await drive(withBloque.app, "anything", { outcome: "paid" });
    expect(absent.statusCode).toBe(404);
    expect(absent.json()).toMatchObject({ message: expect.stringMatching(/not found/) });
    await withBloque.close();
  });

  it("is mounted in staging with KIPPU_PAYMENTS_PROVIDER=test, and never in production", async () => {
    const staging = loadConfig({
      ...environment(database.url, "staging"),
      KIPPU_LEDGER_SERVICE_URL: "http://127.0.0.1:1",
      KIPPU_SPONSOR_URL: "http://127.0.0.1:2",
    });
    const payments = loadPaymentsConfig("staging", { KIPPU_PAYMENTS_PROVIDER: "test" });
    const ledgerBackend = createMemoryBackend({
      profile: createProfileV0({ rpId: "holder.kippu.example" }),
    });
    const withTest = createDomainServices(staging, database.store, {
      ledgerBackend,
      payments: { provider: paymentProviderFor(payments), publicUrl: payments.publicUrl },
    });
    expect(withTest.testingPayments).not.toBeNull();
    const server = createServer(
      staging,
      database.store,
      {},
      {
        ledgerBackend,
        payments: { provider: paymentProviderFor(payments), publicUrl: payments.publicUrl },
      },
    );
    expect((await drive(server.app, "test-checkout-404", { outcome: "paid" })).json()).toEqual({
      error: "no such hosted checkout",
    });
    await server.close();

    const withBloque = createDomainServices(staging, database.store, {
      ledgerBackend,
      payments: {
        provider: createBloquePaymentProvider({ client: {} as never, webhookSecret: "whsec_x" }),
        publicUrl: "https://api.kippu.example",
      },
    });
    expect(withBloque.testingPayments).toBeNull();

    // Production refuses the test provider at configuration, and no wiring would mount it there.
    expect(() => loadPaymentsConfig("production", { KIPPU_PAYMENTS_PROVIDER: "test" })).toThrow(
      /refused in production/,
    );
  });

  async function paidFor() {
    const organiser = await harness.organiser();
    const zone = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: zone, kind: "Unseated" }],
      capacity: 10,
      saleAsset: "COPM/2",
    });
    const { id } = await organiser.client.events.classes.define.mutate({
      event,
      name: "Stalls",
      description: null,
      provenance: "Purchased",
      policy: { kind: "Single" },
      restrictions: { cannotResale: false, cannotTransfer: false },
      quota: null,
      price: 25_000,
    });
    const buyer = await harness.linkedHolder();
    const { token } = await buyer.client.sales.checkout.begin.mutate({
      event,
      zone,
      class: id,
      placement: { kind: "Unseated" },
    });
    const ichiba = harness.anonymous();
    await ichiba.sales.checkout.hold.mutate({ token });
    const payment = await ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS });
    return { token, checkoutId: payment.url.split("/").at(-1) as string };
  }

  it("marks a hosted checkout paid and delivers the provider's webhook, as Bloque would", async () => {
    const { token, checkoutId } = await paidFor();
    const response = await drive(testing, checkoutId, { outcome: "paid" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      checkout: { id: checkoutId, status: "paid", amount: 25_000, asset: "COPM/2" },
      webhook: "delivered",
    });
    const checkout = await harness.anonymous().sales.checkout.get.query({ token });
    expect(checkout.sale?.status).toBe("issued");

    // A checkout no longer open cannot be scripted again.
    expect((await drive(testing, checkoutId, { outcome: "expired" })).statusCode).toBe(409);
  });

  it("marks a checkout cancelled or expired, or paid with no webhook, or for another amount", async () => {
    const cancelled = await paidFor();
    expect(
      (await drive(testing, cancelled.checkoutId, { outcome: "cancelled" })).json(),
    ).toMatchObject({ checkout: { status: "cancelled" } });
    expect(
      (await harness.anonymous().sales.checkout.get.query({ token: cancelled.token })).payment
        ?.status,
    ).toBe("cancelled");

    const expired = await paidFor();
    expect((await drive(testing, expired.checkoutId, { outcome: "expired" })).json()).toMatchObject(
      {
        checkout: { status: "expired" },
      },
    );

    const silent = await paidFor();
    expect(
      (await drive(testing, silent.checkoutId, { outcome: "paid", webhook: false })).json(),
    ).toMatchObject({ webhook: "skipped" });
    expect(
      (await harness.anonymous().sales.checkout.get.query({ token: silent.token })).sale,
    ).toBeNull();

    const short = await paidFor();
    await drive(testing, short.checkoutId, { outcome: "paid", amount: 1 });
    expect(
      (await harness.anonymous().sales.checkout.get.query({ token: short.token })).refund?.reason,
    ).toBe("amount-mismatch");

    expect((await drive(testing, short.checkoutId, { outcome: "refunded" })).statusCode).toBe(400);
  });
});
