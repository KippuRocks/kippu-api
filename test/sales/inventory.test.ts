import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DefineClassInput } from "../../src/events/ports.js";
import { describeWithStore } from "../support/database.js";
import { type EventsHarness, eventsHarness, randomId, refusal } from "../support/events.js";

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

describeWithStore("public sale inventory", () => {
  let harness: EventsHarness;

  beforeAll(async () => {
    harness = await eventsHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("REQ-HD-3: availability drops while a hold is open, and a held or issued seat is not offered — with no session", async () => {
    const organiser = await harness.organiser();
    const seated = randomId();
    const unseated = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [
        { id: seated, kind: "Seated" },
        { id: unseated, kind: "Unseated" },
      ],
      capacity: 5,
      saleAsset: "COPM/2",
    });
    await organiser.client.events.zones.addSeatPositions.mutate({
      event,
      zone: seated,
      positions: ["A-1", "A-2", "A-3"],
    });
    const stalls = await organiser.client.events.classes.define.mutate(
      classInput(event, { quota: 3, description: "Downstairs" }),
    );
    const balcony = await organiser.client.events.classes.define.mutate(
      classInput(event, { name: "Balcony", policy: { kind: "Unlimited", until: null } }),
    );
    const guests = await organiser.client.events.classes.define.mutate(
      classInput(event, { name: "Guests", provenance: "Granted", price: null }),
    );
    const ichiba = harness.anonymous();

    expect(await ichiba.sales.inventory.query({ event })).toEqual({
      event,
      onSale: true,
      asset: "COPM/2",
      available: 5,
      classes: [
        {
          id: stalls.id,
          name: "Stalls",
          description: "Downstairs",
          price: 25_000,
          policy: { kind: "Single" },
          available: 3,
        },
        {
          id: balcony.id,
          name: "Balcony",
          description: null,
          price: 25_000,
          policy: { kind: "Unlimited", until: null },
          available: 5,
        },
      ],
      zones: [
        { id: seated, kind: "Seated", freeSeats: ["A-1", "A-2", "A-3"] },
        { id: unseated, kind: "Unseated" },
      ],
    });

    // A buyer holds A-1.
    const buyer = await harness.linkedHolder();
    const { token } = await buyer.client.sales.checkout.begin.mutate({
      event,
      zone: seated,
      class: stalls.id,
      placement: { kind: "Seated", position: "A-1" },
    });
    expect((await ichiba.sales.checkout.hold.mutate({ token })).outcome).toBe("held");
    const held = await ichiba.sales.inventory.query({ event });
    expect(held.available).toBe(4);
    expect(held.classes.map(({ available }) => available)).toEqual([2, 4]);
    expect(held.zones[0]).toEqual({ id: seated, kind: "Seated", freeSeats: ["A-2", "A-3"] });

    // The organiser grants A-3: issued seats are not offered either.
    await organiser.client.events.tickets.issueGranted.mutate({
      event,
      class: guests.id,
      zone: seated,
      placement: { kind: "Seated", position: "A-3" },
      holder: randomBytes(32).toString("hex"),
    });
    const granted = await ichiba.sales.inventory.query({ event });
    expect(granted.available).toBe(3);
    expect(granted.classes.map(({ available }) => available)).toEqual([2, 3]);
    expect(granted.zones[0]).toEqual({ id: seated, kind: "Seated", freeSeats: ["A-2"] });

    // Released, the hold no longer counts, and A-1 is offered again.
    const checkout = await harness.database.store.query<{ checkout_id: string }>(
      "SELECT checkout_id FROM holds WHERE event = $1",
      [event],
    );
    expect(await harness.sales.holds.release(checkout.rows[0]?.checkout_id as string)).toBe(true);
    const released = await ichiba.sales.inventory.query({ event });
    expect(released.available).toBe(4);
    expect(released.zones[0]).toEqual({ id: seated, kind: "Seated", freeSeats: ["A-1", "A-2"] });
  });

  it("offers every seat of an unbounded event with no quota, and no seat once capacity is taken", async () => {
    const organiser = await harness.organiser();
    const seated = randomId();
    const unbounded = await organiser.client.events.create.mutate({
      zones: [{ id: seated, kind: "Seated" }],
      capacity: null,
      saleAsset: "COPM/2",
    });
    await organiser.client.events.zones.addSeatPositions.mutate({
      event: unbounded.event,
      zone: seated,
      positions: ["B-1"],
    });
    await organiser.client.events.classes.define.mutate(classInput(unbounded.event));
    const inventory = await harness.anonymous().sales.inventory.query({ event: unbounded.event });
    expect(inventory.available).toBeNull();
    expect(inventory.classes.map(({ available }) => available)).toEqual([null]);
    expect(inventory.zones).toEqual([{ id: seated, kind: "Seated", freeSeats: ["B-1"] }]);

    const full = await organiser.client.events.create.mutate({
      zones: [{ id: seated, kind: "Seated" }],
      capacity: 0,
      saleAsset: "COPM/2",
    });
    await organiser.client.events.zones.addSeatPositions.mutate({
      event: full.event,
      zone: seated,
      positions: ["B-1"],
    });
    expect((await harness.anonymous().sales.inventory.query({ event: full.event })).zones).toEqual([
      { id: seated, kind: "Seated", freeSeats: [] },
    ]);
  });

  it("refuses an event the ledger does not have", async () => {
    expect(
      await refusal(() => harness.anonymous().sales.inventory.query({ event: randomId() })),
    ).toEqual({ code: "NOT_FOUND", errorCode: "ERR-EventNotFound" });
  });
});
