import { randomBytes } from "node:crypto";
import type { EventId } from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  refusal,
  refusalWithReason,
  type TestOrganiser,
} from "../support/events.js";

// Store-backed: generous timeouts, so a loaded CI host or database does not fail the suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describeWithStore("capacity decrease", () => {
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
    readonly guests: string;
    readonly stalls: string;
  }

  async function setup(capacity: number | null): Promise<Setup> {
    const organiser = await harness.organiser();
    const zone = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: zone, kind: "Unseated" }],
      capacity,
      saleAsset: "COPM/2",
    });
    const define = (name: string, provenance: "Granted" | "Purchased") =>
      organiser.client.events.classes.define.mutate({
        event,
        name,
        description: null,
        provenance,
        policy: { kind: "Single" },
        restrictions: { cannotResale: false, cannotTransfer: false },
        quota: null,
        price: provenance === "Purchased" ? 25_000 : null,
      });
    const guests = await define("Guests", "Granted");
    const stalls = await define("Stalls", "Purchased");
    return { organiser, event, zone, guests: guests.id, stalls: stalls.id };
  }

  const grant = (context: Setup) =>
    context.organiser.client.events.tickets.issueGranted.mutate({
      event: context.event,
      class: context.guests,
      zone: context.zone,
      placement: { kind: "Unseated" },
      holder: randomBytes(32).toString("hex"),
    });

  async function hold(context: Setup) {
    const buyer = await harness.linkedHolder();
    const { token } = await buyer.client.sales.checkout.begin.mutate({
      event: context.event,
      class: context.stalls,
      zone: context.zone,
      placement: { kind: "Unseated" },
    });
    expect(await harness.anonymous().sales.checkout.hold.mutate({ token })).toMatchObject({
      outcome: "held",
    });
  }

  const onLedger = async (event: string) => {
    const found = await harness.ledger.getEvent(event as EventId);
    if (!found.ok) throw new Error(found.error.code);
    return found.value;
  };

  const capacityWrites = async (event: string) =>
    Number(
      (
        await harness.database.store.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit_log a JOIN organiser_events e ON e.organiser_id = a.organiser_id
           WHERE a.command_kind = 'setEventCapacity' AND e.event = $1`,
          [event],
        )
      ).rows[0]?.n,
    );

  it("AC-A6.1: with n tickets issued, a decrease to any capacity of at least n succeeds", async () => {
    const context = await setup(10);
    await grant(context);
    await grant(context);

    const lowered = await context.organiser.client.events.decreaseCapacity.mutate({
      event: context.event,
      capacity: 6,
    });
    expect(lowered).toMatchObject({
      event: context.event,
      capacity: 6,
      cursor: expect.any(String),
    });
    expect(await onLedger(context.event)).toMatchObject({ maxCapacity: 6, issued: 2 });

    await context.organiser.client.events.decreaseCapacity.mutate({
      event: context.event,
      capacity: 2,
    });
    expect(await onLedger(context.event)).toMatchObject({ maxCapacity: 2, issued: 2 });
    expect(await capacityWrites(context.event)).toBe(2);
  });

  it("AC-A6.2: a capacity below the tickets issued is refused, and no holder's ticket is affected", async () => {
    const context = await setup(10);
    const { ticket } = await grant(context);
    await grant(context);
    await grant(context);

    expect(
      await refusalWithReason(() =>
        context.organiser.client.events.decreaseCapacity.mutate({
          event: context.event,
          capacity: 2,
        }),
      ),
    ).toEqual({
      code: "UNPROCESSABLE_CONTENT",
      errorCode: "ERR-CapacityBelowIssuance",
      reason: null,
    });
    expect(await onLedger(context.event)).toMatchObject({ maxCapacity: 10, issued: 3 });
    expect(await harness.ledger.getTicket(ticket as never)).toMatchObject({ ok: true });
    // Refused before submission: no capacity write reached the ledger.
    expect(await capacityWrites(context.event)).toBe(0);
  });

  it("REQ-HD-4: a capacity below the tickets issued plus outstanding holds is refused before submission", async () => {
    const context = await setup(10);
    await grant(context);
    await hold(context);
    await hold(context);

    // One issued and two held: 2 is at the ledger's floor, but below what the event bears.
    expect(
      await refusalWithReason(() =>
        context.organiser.client.events.decreaseCapacity.mutate({
          event: context.event,
          capacity: 2,
        }),
      ),
    ).toEqual({
      code: "UNPROCESSABLE_CONTENT",
      errorCode: "ERR-CapacityBelowIssuance",
      reason: "held",
    });
    expect(await onLedger(context.event)).toMatchObject({ maxCapacity: 10 });
    expect(await capacityWrites(context.event)).toBe(0);

    await context.organiser.client.events.decreaseCapacity.mutate({
      event: context.event,
      capacity: 3,
    });
    expect(await onLedger(context.event)).toMatchObject({ maxCapacity: 3 });
    // The event is full: another hold is refused.
    const buyer = await harness.linkedHolder();
    const { token } = await buyer.client.sales.checkout.begin.mutate({
      event: context.event,
      class: context.stalls,
      zone: context.zone,
      placement: { kind: "Unseated" },
    });
    expect(await harness.anonymous().sales.checkout.hold.mutate({ token })).toEqual({
      outcome: "refused",
      reason: "sold-out",
    });
  });

  it("AC-A6.3: an increase, or a bound on an unbounded event, is refused without reaching the ledger", async () => {
    const bounded = await setup(5);
    expect(
      await refusal(() =>
        bounded.organiser.client.events.decreaseCapacity.mutate({
          event: bounded.event,
          capacity: 6,
        }),
      ),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-CapacityProofRequired" });
    const unbounded = await setup(null);
    expect(
      await refusal(() =>
        unbounded.organiser.client.events.decreaseCapacity.mutate({
          event: unbounded.event,
          capacity: 100,
        }),
      ),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-CapacityProofRequired" });
    expect(await capacityWrites(bounded.event)).toBe(0);
    expect(await capacityWrites(unbounded.event)).toBe(0);
  });

  it("ERR-NotOwner: only the event's organiser changes its capacity", async () => {
    const context = await setup(10);
    const other = await harness.organiser();

    expect(
      await refusal(() =>
        other.client.events.decreaseCapacity.mutate({ event: context.event, capacity: 5 }),
      ),
    ).toEqual({ code: "FORBIDDEN", errorCode: "ERR-NotOwner" });
    expect(await onLedger(context.event)).toMatchObject({ maxCapacity: 10 });
  });
});
