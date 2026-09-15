import { randomBytes } from "node:crypto";
import type { TicketId, ZoneId } from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DefineClassInput } from "../../src/events/ports.js";
import { HOLD_EXTENSION_MS, HOLD_LIFETIME_MS } from "../../src/sales/holds.js";
import { PAYMENT_WEBHOOK_PATH } from "../../src/sales/payment.js";
import {
  createTestPaymentProvider,
  type TestPaymentProvider,
} from "../../src/sales/payments/test-provider.js";
import type { BeginCheckoutInput, SalesRequest } from "../../src/sales/ports.js";
import { createSales } from "../../src/sales/service.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  refusal,
  type TestOrganiser,
} from "../support/events.js";

const PRICE = 25_000;

const RETURN_URLS = {
  successUrl: "https://ichiba.kippu.example/checkout/paid",
  cancelUrl: "https://ichiba.kippu.example/checkout/cancelled",
};

const classInput = (
  event: string,
  overrides: Partial<DefineClassInput> = {},
): DefineClassInput => ({
  event,
  name: "Stalls",
  description: null,
  provenance: "Purchased",
  policy: { kind: "Multiple", max: 2, until: null },
  restrictions: { cannotResale: false, cannotTransfer: false },
  quota: null,
  price: PRICE,
  ...overrides,
});

describeWithStore("paid checkout", () => {
  let harness: EventsHarness;

  beforeAll(async () => {
    harness = await eventsHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  interface Setup {
    readonly organiser: TestOrganiser;
    readonly event: string;
    readonly seated: string;
    readonly unseated: string;
    readonly classId: string;
  }

  async function setup(capacity: number | null = 10): Promise<Setup> {
    const organiser = await harness.organiser();
    const seated = randomId();
    const unseated = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [
        { id: seated, kind: "Seated" },
        { id: unseated, kind: "Unseated" },
      ],
      capacity,
      saleAsset: "COPM/2",
    });
    await organiser.client.events.zones.addSeatPositions.mutate({
      event,
      zone: seated,
      positions: ["A-1", "A-2"],
    });
    const { id: classId } = await organiser.client.events.classes.define.mutate(classInput(event));
    return { organiser, event, seated, unseated, classId };
  }

  const generalAdmission = ({ event, unseated, classId }: Setup): BeginCheckoutInput => ({
    event,
    zone: unseated,
    class: classId,
    placement: { kind: "Unseated" },
  });

  /** A buyer's checkout, begun in their holder session — so linked and confirmed — and held. */
  async function heldCheckout(input: BeginCheckoutInput) {
    const buyer = await harness.linkedHolder();
    const { token } = await buyer.client.sales.checkout.begin.mutate(input);
    const held = await harness.anonymous().sales.checkout.hold.mutate({ token });
    expect(held.outcome).toBe("held");
    return { token, buyer };
  }

  /** The provider checkout id Kippu created for the checkout's hold. */
  async function providerCheckoutOf(token: string): Promise<string> {
    const { url } = (await harness.anonymous().sales.checkout.get.query({ token })).payment ?? {};
    const id = url?.split("/").at(-1);
    if (id === undefined) throw new Error("no hosted checkout");
    return id;
  }

  /** Delivers the provider's webhook for a checkout to kippu-api's webhook route. */
  async function deliver(provider: TestPaymentProvider, id: string, forged = false) {
    const webhook = forged ? provider.forgedWebhook(id) : provider.webhook(id);
    return fetch(`${harness.address}${PAYMENT_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [provider.webhookSignatureHeader]: webhook.signature,
      },
      body: webhook.rawBody,
    });
  }

  const refunds = async (event: string) =>
    (
      await harness.database.store.query<{ amount: string; asset: string; reason: string }>(
        `SELECT r.amount, r.asset, r.reason FROM refund_entitlements r
         JOIN checkout_sessions c ON c.id = r.checkout_id WHERE c.event = $1`,
        [event],
      )
    ).rows;

  const holdStatuses = async (event: string) =>
    (
      await harness.database.store.query<{ status: string }>(
        "SELECT status FROM holds WHERE event = $1 ORDER BY created_at",
        [event],
      )
    ).rows.map((row) => row.status);

  it("AC-B4.2: a verified payment issues the ticket — Purchased, the class's policy, no restrictions, no price — and confirms the hold", async () => {
    const s = await setup();
    const { token, buyer } = await heldCheckout(generalAdmission(s));
    const ichiba = harness.anonymous();
    const before = await ichiba.sales.checkout.get.query({ token });

    const payment = await ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS });
    const holdExpiry = new Date(before.hold?.expiresAt ?? 0).getTime();
    expect(payment).toEqual({
      status: "open",
      url: expect.stringMatching(/^https:\/\/payments\.test\.invalid\/checkout\//),
      amount: PRICE,
      asset: "COPM/2",
      // The hold's single extension is taken now, and the checkout expires with it.
      expiresAt: new Date(holdExpiry + HOLD_EXTENSION_MS).toISOString(),
    });
    const afterPay = await ichiba.sales.checkout.get.query({ token });
    expect(afterPay.hold).toMatchObject({ extended: true, expiresAt: payment.expiresAt });
    // Paying again answers with the same open checkout.
    expect(await ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS })).toEqual(payment);

    const id = await providerCheckoutOf(token);
    harness.payments.pay(id);
    expect((await deliver(harness.payments, id)).status).toBe(204);

    const paid = await ichiba.sales.checkout.get.query({ token });
    expect(paid.payment?.status).toBe("paid");
    expect(paid.hold?.status).toBe("confirmed");
    expect(paid.sale).toEqual({
      status: "issued",
      ticket: expect.stringMatching(/^[0-9a-f]{64}$/),
      cursor: expect.any(String),
    });
    expect(paid.refund).toBeNull();

    const ticket = await harness.ledger.getTicket(paid.sale?.ticket as TicketId);
    expect(ticket).toMatchObject({
      ok: true,
      value: {
        event: s.event,
        holder: buyer.account,
        class: s.classId,
        provenance: "Purchased",
        policy: { kind: "Multiple", max: 2, until: null },
        restrictions: { cannotResale: false, cannotTransfer: false },
        zone: s.unseated,
      },
    });
    if (!ticket.ok) throw new Error("expected the ticket");
    expect(JSON.stringify(ticket.value)).not.toContain(String(PRICE));

    // A replayed webhook changes nothing: one ticket, no refund.
    expect((await deliver(harness.payments, id)).status).toBe(204);
    const sales = await harness.database.store.query(
      "SELECT 1 FROM primary_sales WHERE hold_id IN (SELECT id FROM holds WHERE event = $1)",
      [s.event],
    );
    expect(sales.rowCount).toBe(1);
    expect(await refunds(s.event)).toEqual([]);
    expect(await ichiba.sales.inventory.query({ event: s.event })).toMatchObject({ available: 9 });
  });

  it("REQ-TC-5: an issued purchased ticket counts against the class quota", async () => {
    const organiser = await harness.organiser();
    const unseated = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: unseated, kind: "Unseated" }],
      capacity: null,
      saleAsset: "DUSD/6",
    });
    const { id: classId } = await organiser.client.events.classes.define.mutate(
      classInput(event, { quota: 1 }),
    );
    const input = {
      event,
      zone: unseated,
      class: classId,
      placement: { kind: "Unseated" },
    } as const;
    const { token } = await heldCheckout(input);
    await harness.anonymous().sales.checkout.pay.mutate({ token, ...RETURN_URLS });
    const id = await providerCheckoutOf(token);
    harness.payments.pay(id);
    await deliver(harness.payments, id);

    const buyer = await harness.linkedHolder();
    const next = await buyer.client.sales.checkout.begin.mutate(input);
    expect(await harness.anonymous().sales.checkout.hold.mutate({ token: next.token })).toEqual({
      outcome: "refused",
      reason: "class-sold-out",
    });
  });

  it("trusts a webhook only when its signature verifies, and the retrieved checkout is paid", async () => {
    const s = await setup();
    const { token } = await heldCheckout(generalAdmission(s));
    await harness.anonymous().sales.checkout.pay.mutate({ token, ...RETURN_URLS });
    const id = await providerCheckoutOf(token);

    // Paid, but the webhook is forged: refused, and nothing is issued.
    harness.payments.pay(id);
    expect((await deliver(harness.payments, id, true)).status).toBe(401);
    expect((await harness.anonymous().sales.checkout.get.query({ token })).sale).toBeNull();

    // A genuine webhook for a checkout that is not paid issues nothing either.
    const other = await heldCheckout(generalAdmission(s));
    await harness.anonymous().sales.checkout.pay.mutate({ token: other.token, ...RETURN_URLS });
    const unpaid = await providerCheckoutOf(other.token);
    expect((await deliver(harness.payments, unpaid)).status).toBe(204);
    expect(
      (await harness.anonymous().sales.checkout.get.query({ token: other.token })).sale,
    ).toBeNull();
  });

  it("AC-B4.3: injected issuance failure after payment produces no ticket and one refund entitlement", async () => {
    const s = await setup();
    // The ledger refuses the issuance: it is submitted for a zone the event does not have.
    const refusing = createSales(
      harness.salesOptions({
        ledger: {
          ...harness.ledger,
          issueTicket: (signer, input) =>
            harness.ledger.issueTicket(signer, { ...input, zone: randomId() as ZoneId }),
        },
      }),
    );
    const { token } = await heldCheckout(generalAdmission(s));
    await harness.anonymous().sales.checkout.pay.mutate({ token, ...RETURN_URLS });
    const id = await providerCheckoutOf(token);
    harness.payments.pay(id);

    const webhook = harness.payments.webhook(id);
    const headers = { [harness.payments.webhookSignatureHeader]: webhook.signature };
    expect(await refusing.paymentWebhook("webhook-1", webhook.rawBody, headers)).toBe(true);
    expect(await refusing.paymentWebhook("webhook-2", webhook.rawBody, headers)).toBe(true);

    const checkout = await harness.anonymous().sales.checkout.get.query({ token });
    expect(checkout.sale).toEqual({ status: "rejected", ticket: expect.any(String), cursor: null });
    expect(await harness.ledger.getTicket(checkout.sale?.ticket as TicketId)).toMatchObject({
      ok: false,
      error: { code: "ERR-TicketNotFound" },
    });
    expect(checkout.refund).toEqual({
      amount: PRICE,
      asset: "COPM/2",
      reason: "issuance-rejected",
    });
    expect(await refunds(s.event)).toEqual([
      { amount: String(PRICE), asset: "COPM/2", reason: "issuance-rejected" },
    ]);
    expect(await holdStatuses(s.event)).toEqual(["released"]);

    // Nothing signed at all: no ticket either, and one refund entitlement.
    const throwing = createSales(
      harness.salesOptions({
        ledger: {
          ...harness.ledger,
          issueTicket: () => {
            throw new Error("the KMS is unreachable");
          },
        },
      }),
    );
    const second = await heldCheckout(generalAdmission(s));
    await harness.anonymous().sales.checkout.pay.mutate({ token: second.token, ...RETURN_URLS });
    const secondId = await providerCheckoutOf(second.token);
    harness.payments.pay(secondId);
    await throwing.payments.reconcile("reconcile", secondId);
    const refused = await harness.anonymous().sales.checkout.get.query({ token: second.token });
    expect(refused.sale).toEqual({ status: "rejected", ticket: null, cursor: null });
    expect(refused.refund?.reason).toBe("issuance-rejected");
    expect(await refunds(s.event)).toHaveLength(2);
  });

  it("AC-B4.3: an unpaid checkout produces neither a ticket nor a refund — abandoned, or lapsed", async () => {
    const s = await setup();
    const ichiba = harness.anonymous();

    // The buyer gives up.
    const abandoned = await heldCheckout(generalAdmission(s));
    await ichiba.sales.checkout.pay.mutate({ token: abandoned.token, ...RETURN_URLS });
    const cancelled = await ichiba.sales.checkout.cancel.mutate({ token: abandoned.token });
    expect(cancelled.payment?.status).toBe("cancelled");
    expect(cancelled.hold?.status).toBe("released");
    expect(cancelled.sale).toBeNull();
    expect(cancelled.refund).toBeNull();

    // The hold lapses: the sweep cancels its hosted checkout.
    let clock = new Date();
    const provider = createTestPaymentProvider({ now: () => clock, prefix: "lapsing" });
    const sales = createSales(harness.salesOptions({ provider, now: () => clock }));
    const buyer = await harness.linkedHolder();
    const request: SalesRequest = {
      requestId: "r",
      principal: { kind: "holder", account: buyer.account, sessionId: buyer.sessionId },
    };
    const { token } = await sales.beginCheckout(request, generalAdmission(s));
    await sales.hold(request, token);
    const payment = await sales.pay(request, { token, ...RETURN_URLS });
    clock = new Date(new Date(payment.expiresAt).getTime() + 1);
    await sales.payments.sweep("sweep");

    const lapsed = await sales.checkout(token);
    expect(lapsed.hold?.status).toBe("lapsed");
    // It expired with the hold, at the provider too; either way it can no longer be paid.
    expect(provider.checkouts().map(({ status }) => status)).toEqual(["expired"]);
    expect(lapsed.payment?.status).toBe("expired");
    expect(lapsed.sale).toBeNull();
    expect(lapsed.refund).toBeNull();
    expect(await refunds(s.event)).toEqual([]);
    await expect(sales.pay(request, { token, ...RETURN_URLS })).rejects.toMatchObject({
      failure: "hold-ended",
    });
  });

  it("replaces a single-use checkout a failed attempt cancelled, while the hold lives", async () => {
    const s = await setup();
    const { token } = await heldCheckout(generalAdmission(s));
    const ichiba = harness.anonymous();
    const first = await ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS });
    harness.payments.failPayment(await providerCheckoutOf(token));

    const second = await ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS });
    expect(second.url).not.toBe(first.url);
    // The hold's extension was taken once, with the first checkout.
    expect(second.expiresAt).toBe(first.expiresAt);
    const id = await providerCheckoutOf(token);
    harness.payments.pay(id);
    await deliver(harness.payments, id);
    expect((await ichiba.sales.checkout.get.query({ token })).sale?.status).toBe("issued");
  });

  it("a payment landing after the hold lapsed is issued while the place is free, and refunded once it is gone", async () => {
    const s = await setup(1);
    let clock = new Date();
    const provider = createTestPaymentProvider({ prefix: "late" });
    const sales = createSales(harness.salesOptions({ provider, now: () => clock }));
    const request = async (): Promise<SalesRequest> => {
      const buyer = await harness.linkedHolder();
      return {
        requestId: randomBytes(4).toString("hex"),
        principal: { kind: "holder", account: buyer.account, sessionId: buyer.sessionId },
      };
    };

    // Late, and the place is still free: the sweep's cancel finds it paid, and it is issued.
    const late = await request();
    const lateCheckout = await sales.beginCheckout(late, generalAdmission(s));
    await sales.hold(late, lateCheckout.token);
    await sales.pay(late, { token: lateCheckout.token, ...RETURN_URLS });
    const lateId = provider.checkouts()[0]?.id as string;
    provider.payBeforeCancel(lateId);
    clock = new Date(clock.getTime() + HOLD_LIFETIME_MS + HOLD_EXTENSION_MS);
    await sales.payments.sweep("sweep");
    expect((await sales.checkout(lateCheckout.token)).sale?.status).toBe("issued");

    // A second event with one place: the first buyer's hold lapses, a second buyer takes the place.
    const t = await setup(1);
    const first = await request();
    const firstCheckout = await sales.beginCheckout(first, generalAdmission(t));
    await sales.hold(first, firstCheckout.token);
    await sales.pay(first, { token: firstCheckout.token, ...RETURN_URLS });
    const firstId = provider.checkouts()[1]?.id as string;
    clock = new Date(clock.getTime() + HOLD_LIFETIME_MS + HOLD_EXTENSION_MS);
    const second = await request();
    const secondCheckout = await sales.beginCheckout(second, generalAdmission(t));
    expect((await sales.hold(second, secondCheckout.token)).outcome).toBe("held");

    // Then the first buyer's payment lands.
    provider.pay(firstId, {});
    await sales.payments.reconcile("late-webhook", firstId);
    const gone = await sales.checkout(firstCheckout.token);
    expect(gone.sale).toBeNull();
    expect(gone.refund).toEqual({ amount: PRICE, asset: "COPM/2", reason: "place-gone" });
  });

  it("refunds a payment for another amount than the price, and issues nothing", async () => {
    const s = await setup();
    const { token } = await heldCheckout(generalAdmission(s));
    await harness.anonymous().sales.checkout.pay.mutate({ token, ...RETURN_URLS });
    const id = await providerCheckoutOf(token);
    harness.payments.pay(id, { amount: 1 });
    await deliver(harness.payments, id);

    const checkout = await harness.anonymous().sales.checkout.get.query({ token });
    expect(checkout.sale).toBeNull();
    expect(checkout.refund).toEqual({ amount: 1, asset: "COPM/2", reason: "amount-mismatch" });
    expect(checkout.hold?.status).toBe("released");
  });

  it("honours a payment that lands just as the buyer cancels", async () => {
    const s = await setup();
    const { token } = await heldCheckout(generalAdmission(s));
    await harness.anonymous().sales.checkout.pay.mutate({ token, ...RETURN_URLS });
    harness.payments.payBeforeCancel(await providerCheckoutOf(token));

    const checkout = await harness.anonymous().sales.checkout.cancel.mutate({ token });
    expect(checkout.sale?.status).toBe("issued");
    expect(checkout.hold?.status).toBe("confirmed");
    expect(checkout.refund).toBeNull();
  });

  it("pays only for an outstanding hold with a confirmed link, once", async () => {
    const s = await setup();
    const ichiba = harness.anonymous();
    const unheld = await (await harness.linkedHolder()).client.sales.checkout.begin.mutate(
      generalAdmission(s),
    );
    expect(
      await refusal(() =>
        ichiba.sales.checkout.pay.mutate({ token: unheld.token, ...RETURN_URLS }),
      ),
    ).toEqual({ code: "PRECONDITION_FAILED", errorCode: null });

    const { token } = await heldCheckout(generalAdmission(s));
    expect(
      await refusal(() =>
        ichiba.sales.checkout.pay.mutate({
          token,
          successUrl: "javascript:alert(1)",
          cancelUrl: RETURN_URLS.cancelUrl,
        }),
      ),
    ).toEqual({ code: "BAD_REQUEST", errorCode: null });

    await ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS });
    const id = await providerCheckoutOf(token);
    harness.payments.pay(id);
    await deliver(harness.payments, id);
    expect(
      await refusal(() => ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS })),
    ).toEqual({
      code: "CONFLICT",
      errorCode: null,
    });

    harness.payments.failNext("createCheckout");
    const other = await heldCheckout(generalAdmission(s));
    expect(
      await refusal(() => ichiba.sales.checkout.pay.mutate({ token: other.token, ...RETURN_URLS })),
    ).toEqual({ code: "SERVICE_UNAVAILABLE", errorCode: null });
    // Nothing was taken: the extension is still to come.
    expect((await ichiba.sales.checkout.get.query({ token: other.token })).hold?.extended).toBe(
      false,
    );
  });
});
