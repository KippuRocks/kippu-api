import { afterAll, beforeAll, expect, it } from "vitest";
import { ledgerFactsProjection } from "../../src/derived/ledger-facts.js";
import { createDerivedReader, type DerivedReader } from "../../src/derived/reader.js";
import { describeWithStore } from "../support/database.js";
import { type EventsHarness, eventsHarness, randomId, refusal } from "../support/events.js";

const RETURN_URLS = {
  successUrl: "https://ichiba.kippu.example/checkout/paid",
  cancelUrl: "https://ichiba.kippu.example/checkout/cancelled",
};

describeWithStore("a checkout reports when its ticket is visible", () => {
  let harness: EventsHarness;
  let reader: DerivedReader;

  beforeAll(async () => {
    harness = await eventsHarness();
    reader = createDerivedReader({
      store: harness.database.store,
      log: harness.ledger.log,
      projections: [ledgerFactsProjection(harness.ledger)],
      onError: (error) => {
        throw error;
      },
    });
  });

  afterAll(async () => {
    await reader.stop();
    await harness.close();
  });

  /** A checkout paid for and issued, over tRPC with no session but the page's token. */
  async function issued() {
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
    const providerCheckout = payment.url.split("/").at(-1) as string;
    harness.payments.pay(providerCheckout);
    await harness.sales.payments.reconcile("webhook", providerCheckout);
    return { token, ichiba };
  }

  it("NFR-11: ticketVisible turns true only once Kippu's copy has passed the issuance receipt", async () => {
    const { token, ichiba } = await issued();

    // Issued on the ledger, but the copy has not read it: not visible, even after a bounded wait.
    const before = await ichiba.sales.checkout.get.query({ token });
    expect(before.sale?.status).toBe("issued");
    expect(before.ticketVisible).toBe(false);
    const started = Date.now();
    expect(
      (await ichiba.sales.checkout.get.query({ token, waitForTicketMs: 300 })).ticketVisible,
    ).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);

    // The copy reads the ledger: a waiting read answers as soon as it has passed the receipt.
    const waiting = ichiba.sales.checkout.get.query({ token, waitForTicketMs: 10_000 });
    reader.start();
    expect((await waiting).ticketVisible).toBe(true);
    expect((await ichiba.sales.checkout.get.query({ token })).ticketVisible).toBe(true);
  });

  it("answers at once, not visible, while the sale is not issued — and bounds the wait to 10 s", async () => {
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
    const started = Date.now();
    const unissued = await ichiba.sales.checkout.get.query({ token, waitForTicketMs: 10_000 });
    expect(unissued).toMatchObject({ sale: null, ticketVisible: false });
    expect(Date.now() - started).toBeLessThan(2_000);

    expect(
      await refusal(() => ichiba.sales.checkout.get.query({ token, waitForTicketMs: 10_001 })),
    ).toEqual({ code: "BAD_REQUEST", errorCode: null });
  });
});
