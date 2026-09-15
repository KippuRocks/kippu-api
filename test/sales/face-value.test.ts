import { randomBytes } from "node:crypto";
import type { TicketId, ZoneId } from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
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

describeWithStore("face value", () => {
  let harness: EventsHarness;

  beforeAll(async () => {
    harness = await eventsHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("REQ-MP-2: every purchased ticket has a face-value row — the price its hold recorded", async () => {
    const organiser = await harness.organiser();
    const seated = randomId();
    const unseated = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [
        { id: seated, kind: "Seated" },
        { id: unseated, kind: "Unseated" },
      ],
      capacity: 20,
      saleAsset: "DUSD/6",
    });
    await organiser.client.events.zones.addSeatPositions.mutate({
      event,
      zone: seated,
      positions: ["A-1", "A-2"],
    });
    const stalls = await organiser.client.events.classes.define.mutate(classInput(event));
    const balcony = await organiser.client.events.classes.define.mutate(
      classInput(event, { name: "Balcony", price: 9_000_000 }),
    );
    const guests = await organiser.client.events.classes.define.mutate(
      classInput(event, { name: "Guests", provenance: "Granted", price: null }),
    );
    const ichiba = harness.anonymous();

    /** A buyer holds, then pays; the provider's payment is reconciled. Answers the checkout token. */
    const purchase = async (
      input: {
        class: string;
        zone: string;
        placement: { kind: "Seated"; position: string } | { kind: "Unseated" };
      },
      sales = harness.sales,
    ) => {
      const buyer = await harness.linkedHolder();
      const { token } = await buyer.client.sales.checkout.begin.mutate({ event, ...input });
      expect((await ichiba.sales.checkout.hold.mutate({ token })).outcome).toBe("held");
      return {
        token,
        pay: async () => {
          const payment = await ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS });
          const id = payment.url.split("/").at(-1) as string;
          harness.payments.pay(id);
          await sales.payments.reconcile("webhook", id);
          return (await ichiba.sales.checkout.get.query({ token })).sale;
        },
      };
    };

    // Held at 25,000; the price then changes, and the next hold is at 30,000.
    const first = await purchase({
      class: stalls.id,
      zone: seated,
      placement: { kind: "Seated", position: "A-1" },
    });
    await organiser.client.events.classes.setPrice.mutate({
      event,
      class: stalls.id,
      price: 30_000,
    });
    const second = await purchase({
      class: stalls.id,
      zone: unseated,
      placement: { kind: "Unseated" },
    });
    const third = await purchase({
      class: balcony.id,
      zone: unseated,
      placement: { kind: "Unseated" },
    });
    const sold = [await first.pay(), await second.pay(), await third.pay()];
    expect(sold.map((sale) => sale?.status)).toEqual(["issued", "issued", "issued"]);

    // A sale the ledger refuses issues no ticket, and records no face value.
    const refusing = createSales(
      harness.salesOptions({
        ledger: {
          ...harness.ledger,
          issueTicket: (signer, input) =>
            harness.ledger.issueTicket(signer, { ...input, zone: randomId() as ZoneId }),
        },
      }),
    );
    const refused = await purchase(
      { class: stalls.id, zone: unseated, placement: { kind: "Unseated" } },
      refusing,
    );
    expect((await refused.pay())?.status).toBe("rejected");

    // A granted ticket is free: no face value (REQ-TC-4).
    const granted = await organiser.client.events.tickets.issueGranted.mutate({
      event,
      class: guests.id,
      zone: seated,
      placement: { kind: "Seated", position: "A-2" },
      holder: randomBytes(32).toString("hex"),
    });

    const rows = await harness.database.store.query<{
      ticket: string;
      class_id: string;
      amount: string;
      asset: string;
    }>("SELECT ticket, class_id, amount, asset FROM face_values WHERE event = $1", [event]);
    expect(new Map(rows.rows.map((row) => [row.ticket, row]))).toEqual(
      new Map([
        [
          sold[0]?.ticket,
          { ticket: sold[0]?.ticket, class_id: stalls.id, amount: "25000", asset: "DUSD/6" },
        ],
        [
          sold[1]?.ticket,
          { ticket: sold[1]?.ticket, class_id: stalls.id, amount: "30000", asset: "DUSD/6" },
        ],
        [
          sold[2]?.ticket,
          { ticket: sold[2]?.ticket, class_id: balcony.id, amount: "9000000", asset: "DUSD/6" },
        ],
      ]),
    );

    // Every issued sale of the event has its row, and each row names a Purchased ticket on the ledger.
    const issued = await harness.database.store.query<{ ticket: string }>(
      `SELECT s.ticket FROM primary_sales s JOIN holds h ON h.id = s.hold_id
       WHERE h.event = $1 AND s.status = 'issued'`,
      [event],
    );
    expect(issued.rows.map((row) => row.ticket).sort()).toEqual(
      rows.rows.map((row) => row.ticket).sort(),
    );
    for (const row of rows.rows) {
      expect(await harness.ledger.getTicket(row.ticket as TicketId)).toMatchObject({
        ok: true,
        value: { provenance: "Purchased", event },
      });
    }
    expect(rows.rows.map((row) => row.ticket)).not.toContain(granted.ticket);
  });
});
