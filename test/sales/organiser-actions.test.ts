import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { OrganiserPrincipal } from "../../src/auth/ports.js";
import type { DefineClassInput } from "../../src/events/ports.js";
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
  policy: { kind: "Single" },
  restrictions: { cannotResale: false, cannotTransfer: false },
  quota: null,
  price: PRICE,
  ...overrides,
});

describeWithStore("holds against organiser actions", () => {
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
    readonly zone: string;
    readonly classId: string;
  }

  async function setup(capacity: number | null = 10): Promise<Setup> {
    const organiser = await harness.organiser();
    const zone = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: zone, kind: "Unseated" }],
      capacity,
      saleAsset: "COPM/2",
    });
    const { id: classId } = await organiser.client.events.classes.define.mutate(classInput(event));
    return { organiser, event, zone, classId };
  }

  const cause = (s: Setup) => ({
    requestId: `seal-${randomBytes(4).toString("hex")}`,
    actor: s.organiser.request.principal as OrganiserPrincipal,
  });

  /** A buyer's held checkout, with its hosted checkout open. Answers the token and provider checkout id. */
  async function openCheckout(s: Setup) {
    const buyer = await harness.linkedHolder();
    const { token } = await buyer.client.sales.checkout.begin.mutate({
      event: s.event,
      zone: s.zone,
      class: s.classId,
      placement: { kind: "Unseated" },
    });
    const ichiba = harness.anonymous();
    expect((await ichiba.sales.checkout.hold.mutate({ token })).outcome).toBe("held");
    const payment = await ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS });
    return { token, buyer, providerCheckout: payment.url.split("/").at(-1) as string };
  }

  it("REQ-HD-4: sealing during an open checkout releases the hold and cancels its hosted checkout", async () => {
    const s = await setup();
    const { token, providerCheckout } = await openCheckout(s);
    const ichiba = harness.anonymous();

    const released = await harness.sales.organiserActions.releaseAll(s.event, cause(s));
    expect(released).toEqual({ released: 1, cancelled: 1, refunds: 0 });

    const checkout = await ichiba.sales.checkout.get.query({ token });
    expect(checkout.hold?.status).toBe("released");
    expect(checkout.payment?.status).toBe("cancelled");
    expect(checkout.sale).toBeNull();
    expect(checkout.refund).toBeNull();
    // The buyer can no longer pay: the hosted checkout is cancelled at the provider.
    expect(harness.payments.checkouts().find(({ id }) => id === providerCheckout)?.status).toBe(
      "cancelled",
    );
    expect(() => harness.payments.pay(providerCheckout)).toThrow(/cancelled/);

    // Until the seal lands, the event's sales are closed: no checkout, hold or payment.
    expect(
      await refusal(() => ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS })),
    ).toEqual({
      code: "CONFLICT",
      errorCode: null,
    });
    const buyer = await harness.linkedHolder();
    expect(
      await refusal(() =>
        buyer.client.sales.checkout.begin.mutate({
          event: s.event,
          zone: s.zone,
          class: s.classId,
          placement: { kind: "Unseated" },
        }),
      ),
    ).toEqual({ code: "CONFLICT", errorCode: null });
    expect(await ichiba.sales.inventory.query({ event: s.event })).toMatchObject({
      onSale: false,
    });

    // The steps are the organiser's.
    const steps = await harness.database.store.query<{ step: string; actor: string }>(
      `SELECT a.step, a.actor FROM checkout_audit a JOIN checkout_sessions c ON c.id = a.checkout_id
       WHERE c.event = $1 AND a.actor = 'organiser' ORDER BY a.id`,
      [s.event],
    );
    expect(steps.rows).toEqual([
      { step: "checkout-cancelled", actor: "organiser" },
      { step: "hold-released", actor: "organiser" },
    ]);
  });

  it("REQ-HD-4: a payment already taken against a released hold is refunded, never issued", async () => {
    const s = await setup();
    const ichiba = harness.anonymous();

    // Paid just as the organiser seals: the cancel finds it paid.
    const racing = await openCheckout(s);
    harness.payments.payBeforeCancel(racing.providerCheckout);
    // Paid, with its webhook still on the way.
    const late = await openCheckout(s);
    harness.payments.pay(late.providerCheckout);
    // Unpaid.
    await openCheckout(s);

    const released = await harness.sales.organiserActions.releaseAll(s.event, cause(s));
    expect(released).toEqual({ released: 3, cancelled: 1, refunds: 2 });

    for (const { token } of [racing, late]) {
      const checkout = await ichiba.sales.checkout.get.query({ token });
      expect(checkout.sale).toBeNull();
      expect(checkout.refund).toEqual({ amount: PRICE, asset: "COPM/2", reason: "event-closed" });
      expect(checkout.hold?.status).toBe("released");
    }
    // The late webhook arrives: it changes nothing.
    await harness.sales.payments.reconcile("late-webhook", late.providerCheckout);
    const entitlements = await harness.database.store.query(
      `SELECT 1 FROM refund_entitlements r JOIN checkout_sessions c ON c.id = r.checkout_id
       WHERE c.event = $1`,
      [s.event],
    );
    expect(entitlements.rowCount).toBe(2);
    const sales = await harness.database.store.query(
      "SELECT 1 FROM primary_sales s JOIN holds h ON h.id = s.hold_id WHERE h.event = $1",
      [s.event],
    );
    expect(sales.rowCount).toBe(0);
  });

  it("reopens sales when the organiser's write is refused", async () => {
    const s = await setup();
    await openCheckout(s);
    await harness.sales.organiserActions.releaseAll(s.event, cause(s));
    expect(await harness.sales.organiserActions.releaseAll(s.event, cause(s))).toEqual({
      released: 0,
      cancelled: 0,
      refunds: 0,
    });

    expect(await harness.sales.organiserActions.reopenSales(s.event, cause(s))).toBe(true);
    expect(await harness.sales.organiserActions.reopenSales(s.event, cause(s))).toBe(false);
    const { token } = await openCheckout(s);
    expect((await harness.anonymous().sales.checkout.get.query({ token })).payment?.status).toBe(
      "open",
    );
  });

  it("REQ-HD-4: a capacity decrease is allowed only down to issued tickets plus outstanding holds", async () => {
    const s = await setup(10);
    const actions = harness.sales.organiserActions;

    // One granted ticket, one purchased and issued, one hold outstanding: three allocated.
    const guests = await s.organiser.client.events.classes.define.mutate(
      classInput(s.event, { name: "Guests", provenance: "Granted", price: null }),
    );
    await s.organiser.client.events.tickets.issueGranted.mutate({
      event: s.event,
      class: guests.id,
      zone: s.zone,
      placement: { kind: "Unseated" },
      holder: randomBytes(32).toString("hex"),
    });
    const bought = await openCheckout(s);
    harness.payments.pay(bought.providerCheckout);
    await harness.sales.payments.reconcile("webhook", bought.providerCheckout);
    await openCheckout(s);

    expect(await actions.canDecreaseCapacity(s.event, 10)).toBe(true);
    expect(await actions.canDecreaseCapacity(s.event, 3)).toBe(true);
    expect(await actions.canDecreaseCapacity(s.event, 2)).toBe(false);

    // Inside the organiser's own transaction, under the event's allocation lock.
    const client = await harness.database.store.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [0x686f6c64, s.event]);
      expect(await actions.canDecreaseCapacity(s.event, 2, client)).toBe(false);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    await actions.releaseAll(s.event, cause(s));
    expect(await actions.canDecreaseCapacity(s.event, 2)).toBe(true);
    expect(await actions.canDecreaseCapacity(s.event, 1)).toBe(false);
    expect(
      await actions
        .canDecreaseCapacity(randomId(), 1)
        .catch((error: { code: string }) => error.code),
    ).toBe("ERR-EventNotFound");
  });
});
