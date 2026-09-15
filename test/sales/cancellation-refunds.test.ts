import { randomBytes } from "node:crypto";
import type { AccountId, EventId, TicketId, ZoneId } from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { OrganiserPrincipal } from "../../src/auth/ports.js";
import type { DefineClassInput } from "../../src/events/ports.js";
import { createSales } from "../../src/sales/service.js";
import { describeWithStore } from "../support/database.js";
import { type EventsHarness, eventsHarness, randomId } from "../support/events.js";

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
  price: 25_000,
  ...overrides,
});

describeWithStore("cancellation refund entitlements", () => {
  let harness: EventsHarness;

  beforeAll(async () => {
    harness = await eventsHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("AC-A5.5: one entitlement per purchased ticket, including transferred ones — to the original purchaser, with the holder at cancellation recorded", async () => {
    const organiser = await harness.organiser();
    const zone = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: zone, kind: "Unseated" }],
      capacity: 20,
      saleAsset: "DUSD/6",
    });
    const stalls = await organiser.client.events.classes.define.mutate(classInput(event));
    const ichiba = harness.anonymous();

    /** A buyer's purchase through checkout, reconciled by `sales`. */
    const purchase = async (sales = harness.sales) => {
      const buyer = await harness.linkedHolder();
      const { token } = await buyer.client.sales.checkout.begin.mutate({
        event,
        zone,
        class: stalls.id,
        placement: { kind: "Unseated" },
      });
      await ichiba.sales.checkout.hold.mutate({ token });
      const payment = await ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS });
      const id = payment.url.split("/").at(-1) as string;
      harness.payments.pay(id);
      await sales.payments.reconcile("webhook", id);
      return { buyer, token, sale: (await ichiba.sales.checkout.get.query({ token })).sale };
    };

    const transferred = await purchase();
    const kept = await purchase();
    // Repriced: the next sale's face value differs.
    await organiser.client.events.classes.setPrice.mutate({
      event,
      class: stalls.id,
      price: 30_000,
    });
    const noVerdict = await purchase();
    // The ledger refuses one: it has its own entitlement, and no ticket to refund.
    const refused = await purchase(
      createSales(
        harness.salesOptions({
          ledger: {
            ...harness.ledger,
            issueTicket: (signer, input) =>
              harness.ledger.issueTicket(signer, { ...input, zone: randomId() as ZoneId }),
          },
        }),
      ),
    );
    expect([transferred, kept, noVerdict].map(({ sale }) => sale?.status)).toEqual([
      "issued",
      "issued",
      "issued",
    ]);
    expect(refused.sale?.status).toBe("rejected");
    // One sale's submission is recorded as having had no verdict: the ledger holds its ticket.
    await harness.database.store.query(
      `UPDATE primary_sales SET status = 'failed', receipt_cursor = NULL WHERE ticket = $1`,
      [noVerdict.sale?.ticket],
    );
    // A granted ticket is free: nothing to refund.
    const guests = await organiser.client.events.classes.define.mutate(
      classInput(event, { name: "Guests", provenance: "Granted", price: null }),
    );
    await organiser.client.events.tickets.issueGranted.mutate({
      event,
      class: guests.id,
      zone,
      placement: { kind: "Unseated" },
      holder: randomBytes(32).toString("hex"),
    });

    // The event is cancelled on the ledger, after `transferred` changed hands. backend-memory
    // cannot yet cancel or transfer (T-008-04, T-008-08), so the ledger's answers are hand-built
    // as its rules give them: the holder fixed at cancellation, else the holder.
    const transferee = randomBytes(32).toString("hex") as AccountId;
    const cancelled = createSales(
      harness.salesOptions({
        ledger: {
          ...harness.ledger,
          getEvent: async (id: EventId) => {
            const found = await harness.ledger.getEvent(id);
            return found.ok && id === event
              ? { ok: true, value: { ...found.value, status: "Cancelled" } }
              : found;
          },
          getCancellationHolder: async (ticket: TicketId) => {
            if (ticket === transferred.sale?.ticket) return { ok: true, value: transferee };
            const found = await harness.ledger.getTicket(ticket);
            return found.ok ? { ok: true, value: found.value.holder } : found;
          },
        },
      }),
    );
    const cause = {
      requestId: "cancel-request",
      actor: organiser.request.principal as OrganiserPrincipal,
    };

    const first = await cancelled.organiserActions.recordCancellationRefunds(event, cause);
    expect(first).toEqual({ recorded: 3, existing: 0, unaccounted: [] });

    const entitlements = await harness.database.store.query<{
      ticket: string;
      purchaser_account: string;
      holder_at_cancellation: string;
      amount: string;
      asset: string;
    }>(
      `SELECT ticket, purchaser_account, holder_at_cancellation, amount, asset
       FROM refund_entitlements r JOIN checkout_sessions c ON c.id = r.checkout_id
       WHERE c.event = $1 AND r.reason = 'event-cancelled' ORDER BY r.created_at`,
      [event],
    );
    expect(entitlements.rows).toEqual([
      {
        ticket: transferred.sale?.ticket,
        // Refunded to the purchaser, whatever transfers followed (DEF-12).
        purchaser_account: transferred.buyer.account,
        holder_at_cancellation: transferee,
        amount: "25000",
        asset: "DUSD/6",
      },
      {
        ticket: kept.sale?.ticket,
        purchaser_account: kept.buyer.account,
        holder_at_cancellation: kept.buyer.account,
        amount: "25000",
        asset: "DUSD/6",
      },
      {
        ticket: noVerdict.sale?.ticket,
        purchaser_account: noVerdict.buyer.account,
        holder_at_cancellation: noVerdict.buyer.account,
        amount: "30000",
        asset: "DUSD/6",
      },
    ]);

    // At most once (AC-A5.5): running again records nothing.
    expect(await cancelled.organiserActions.recordCancellationRefunds(event, cause)).toEqual({
      recorded: 0,
      existing: 3,
      unaccounted: [],
    });
    const all = await harness.database.store.query<{ reason: string }>(
      `SELECT reason FROM refund_entitlements r JOIN checkout_sessions c ON c.id = r.checkout_id
       WHERE c.event = $1 ORDER BY reason`,
      [event],
    );
    expect(all.rows.map((row) => row.reason)).toEqual([
      "event-cancelled",
      "event-cancelled",
      "event-cancelled",
      "issuance-rejected",
    ]);

    // The buyer sees the refund on their checkout; the organiser's cancellation caused it.
    expect((await ichiba.sales.checkout.get.query({ token: transferred.token })).refund).toEqual({
      amount: 25_000,
      asset: "DUSD/6",
      reason: "event-cancelled",
    });
    const step = await harness.database.store.query<{ actor: string; request_id: string }>(
      `SELECT a.actor, a.request_id FROM checkout_audit a JOIN checkout_sessions c ON c.id = a.checkout_id
       WHERE c.event = $1 AND a.step = 'refund-entitled' AND a.detail ->> 'reason' = 'event-cancelled'`,
      [event],
    );
    expect(step.rows).toEqual(Array(3).fill({ actor: "organiser", request_id: "cancel-request" }));
  });

  it("records nothing for an event that is not cancelled", async () => {
    const organiser = await harness.organiser();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: randomId(), kind: "Unseated" }],
      capacity: 5,
      saleAsset: "COPM/2",
    });
    await expect(
      harness.sales.organiserActions.recordCancellationRefunds(event, {
        requestId: "r",
        actor: organiser.request.principal as OrganiserPrincipal,
      }),
    ).rejects.toThrow(/not Active/);
    await expect(
      harness.sales.organiserActions.recordCancellationRefunds(randomId(), {
        requestId: "r",
        actor: organiser.request.principal as OrganiserPrincipal,
      }),
    ).rejects.toMatchObject({ code: "ERR-EventNotFound" });
  });
});
