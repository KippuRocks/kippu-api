import { randomBytes } from "node:crypto";
import type { EventId, TicketId } from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DefineClassInput, IssueGrantedInput } from "../../src/events/ports.js";
import { positionOf } from "../../src/events/zones.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  refusal,
  type TestOrganiser,
} from "../support/events.js";
import { expectEveryRelayedWriteAudited } from "../support/ledger.js";

/** A holder's account id. Issuance names an account; it holds no credential of the holder's. */
const holderAccount = () => randomBytes(32).toString("hex");

const granted = (event: string, overrides: Partial<DefineClassInput> = {}): DefineClassInput => ({
  event,
  name: "Guest list",
  description: null,
  provenance: "Granted",
  policy: { kind: "Single" },
  restrictions: { cannotResale: false, cannotTransfer: false },
  quota: null,
  ...overrides,
});

describeWithStore("granted issuance", () => {
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
  }

  async function setup(capacity: number | null = null): Promise<Setup> {
    const organiser = await harness.organiser();
    const seated = randomId();
    const unseated = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [
        { id: seated, kind: "Seated" },
        { id: unseated, kind: "Unseated" },
      ],
      capacity,
    });
    return { organiser, event, seated, unseated };
  }

  const unseatedTicket = (
    { event, unseated }: Setup,
    classId: string,
    holder = holderAccount(),
  ): IssueGrantedInput => ({
    event,
    class: classId,
    zone: unseated,
    placement: { kind: "Unseated" },
    holder,
  });

  const ticketOnLedger = async (ticket: string) => {
    const found = await harness.ledger.getTicket(ticket as TicketId);
    if (!found.ok) throw new Error(found.error.code);
    return found.value;
  };

  /** Row counts of every table in the Kippu store. */
  async function rowCounts(): Promise<Record<string, number>> {
    const tables = await harness.database.store.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const counts: Record<string, number> = {};
    for (const { table_name } of tables.rows) {
      const counted = await harness.database.store.query<{ count: string }>(
        `SELECT count(*) FROM "${table_name}"`,
      );
      counts[table_name] = Number(counted.rows[0]?.count);
    }
    return counts;
  }

  it("AC-B2.2: a granted ticket is issued free, and no payment flow of any kind occurs", async () => {
    const context = await setup();
    const guests = await context.organiser.client.events.classes.define.mutate(
      granted(context.event),
    );
    const holder = holderAccount();
    const before = await rowCounts();

    const { ticket, cursor } = await context.organiser.client.events.tickets.issueGranted.mutate(
      unseatedTicket(context, guests.id, holder),
    );

    expect(cursor).toEqual(expect.any(String));
    expect(await ticketOnLedger(ticket)).toMatchObject({
      event: context.event,
      holder,
      provenance: "Granted",
      zone: context.unseated,
      placement: { kind: "Unseated" },
    });
    // REQ-TC-4: the issuance wrote its audit row and its issuance record, and nothing
    // else — no transaction, no zero-value charge, no invoice, anywhere in the store.
    const after = await rowCounts();
    const changed = Object.keys(after).filter((table) => after[table] !== before[table]);
    expect(changed.sort()).toEqual(["audit_log", "granted_issuances"]);
    expect(after.audit_log).toBe((before.audit_log ?? 0) + 1);
    expect(after.granted_issuances).toBe((before.granted_issuances ?? 0) + 1);
    const columns = await harness.database.store.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'granted_issuances'",
    );
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/price|amount|payment|charge|invoice/)]),
    );
    const issuance = await harness.database.store.query<{ operation_id: string }>(
      "SELECT operation_id FROM granted_issuances WHERE ticket = $1 AND status = 'settled'",
      [ticket],
    );
    await expectEveryRelayedWriteAudited(
      harness.audit,
      issuance.rows.map((row) => row.operation_id as never),
    );
  });

  it("AC-B2.3: tickets from two granted classes carry each class's own policy and restrictions", async () => {
    const context = await setup();
    const press = await context.organiser.client.events.classes.define.mutate(
      granted(context.event, {
        name: "Press",
        policy: { kind: "Single" },
        restrictions: { cannotResale: true, cannotTransfer: true },
      }),
    );
    const artists = await context.organiser.client.events.classes.define.mutate(
      granted(context.event, {
        name: "Artist guests",
        policy: { kind: "Multiple", max: 2, until: 1_900_000_000_000 },
        restrictions: { cannotResale: true, cannotTransfer: false },
      }),
    );

    const pressTicket = await context.organiser.client.events.tickets.issueGranted.mutate(
      unseatedTicket(context, press.id),
    );
    const artistTicket = await context.organiser.client.events.tickets.issueGranted.mutate(
      unseatedTicket(context, artists.id),
    );

    expect(await ticketOnLedger(pressTicket.ticket)).toMatchObject({
      class: press.id,
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: true, cannotTransfer: true },
    });
    expect(await ticketOnLedger(artistTicket.ticket)).toMatchObject({
      class: artists.id,
      provenance: "Granted",
      policy: { kind: "Multiple", max: 2, until: 1_900_000_000_000 },
      restrictions: { cannotResale: true, cannotTransfer: false },
    });
  });

  it("AC-B2.4: once a class has issued its quota, further issuance from it fails, independently of capacity", async () => {
    const context = await setup(1000);
    const staff = await context.organiser.client.events.classes.define.mutate(
      granted(context.event, { name: "Staff", quota: 2 }),
    );
    const press = await context.organiser.client.events.classes.define.mutate(
      granted(context.event, { name: "Press", quota: 5 }),
    );

    for (let issued = 0; issued < 2; issued += 1) {
      await context.organiser.client.events.tickets.issueGranted.mutate(
        unseatedTicket(context, staff.id),
      );
    }
    const sponsoredBefore = harness.sponsored.length;

    expect(
      await refusal(() =>
        context.organiser.client.events.tickets.issueGranted.mutate(
          unseatedTicket(context, staff.id),
        ),
      ),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-ClassQuotaExceeded" });
    // Refused by Kippu before anything was signed; the event has room, and another class issues.
    expect(harness.sponsored.length).toBe(sponsoredBefore);
    expect(await harness.ledger.getEvent(context.event as EventId)).toMatchObject({
      ok: true,
      value: { issued: 2, maxCapacity: 1000 },
    });
    await expect(
      context.organiser.client.events.tickets.issueGranted.mutate(
        unseatedTicket(context, press.id),
      ),
    ).resolves.toMatchObject({ ticket: expect.any(String) });
  });

  it("ERR-ClassQuotaExceeded: concurrent issuances never exceed the class quota", async () => {
    const context = await setup();
    const staff = await context.organiser.client.events.classes.define.mutate(
      granted(context.event, { quota: 3 }),
    );

    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        context.organiser.client.events.tickets.issueGranted.mutate(
          unseatedTicket(context, staff.id),
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(3);
    const refused = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(refused).toHaveLength(5);
    for (const outcome of refused) {
      expect((outcome.reason as { data?: { errorCode?: string } }).data?.errorCode).toBe(
        "ERR-ClassQuotaExceeded",
      );
    }
    expect(await harness.ledger.getEvent(context.event as EventId)).toMatchObject({
      ok: true,
      value: { issued: 3 },
    });
  });

  it("AC-B2.5: granted tickets count against the event's capacity", async () => {
    const context = await setup(2);
    const guests = await context.organiser.client.events.classes.define.mutate(
      granted(context.event),
    );

    await context.organiser.client.events.tickets.issueGranted.mutate(
      unseatedTicket(context, guests.id),
    );
    await context.organiser.client.events.tickets.issueGranted.mutate(
      unseatedTicket(context, guests.id),
    );

    expect(
      await refusal(() =>
        context.organiser.client.events.tickets.issueGranted.mutate(
          unseatedTicket(context, guests.id),
        ),
      ),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-CapacityExceeded" });
    expect(await harness.ledger.getEvent(context.event as EventId)).toMatchObject({
      ok: true,
      value: { issued: 2, maxCapacity: 2 },
    });
  });

  it("AC-B2.6: a ticket's class is recorded on the ledger, and Kippu makes it legible", async () => {
    const context = await setup();
    const press = await context.organiser.client.events.classes.define.mutate(
      granted(context.event, {
        name: "Press",
        restrictions: { cannotResale: true, cannotTransfer: true },
      }),
    );

    const { ticket } = await context.organiser.client.events.tickets.issueGranted.mutate(
      unseatedTicket(context, press.id),
    );

    const onLedger = await ticketOnLedger(ticket);
    expect(onLedger.class).toBe(press.id);
    // Without Kippu, only provenance, policy and restrictions say what the ticket is.
    expect(onLedger).toMatchObject({
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: true, cannotTransfer: true },
    });
    // Through Kippu, the class id resolves to the class: a press pass is legible as one.
    expect(await harness.events.classes.find(onLedger.event, onLedger.class)).toMatchObject({
      name: "Press",
    });
  });

  it("ERR-UnknownClass: issuance names a class defined for the event", async () => {
    const context = await setup();
    const elsewhere = await setup();
    const otherEventsClass = await elsewhere.organiser.client.events.classes.define.mutate(
      granted(elsewhere.event),
    );
    const sponsoredBefore = harness.sponsored.length;

    for (const classId of [randomId(), otherEventsClass.id]) {
      expect(
        await refusal(() =>
          context.organiser.client.events.tickets.issueGranted.mutate(
            unseatedTicket(context, classId),
          ),
        ),
      ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-UnknownClass" });
    }
    expect(harness.sponsored.length).toBe(sponsoredBefore);
  });

  it("REQ-ID-3: a seat is issued only at one of its zone's canonical positions, refused before submission", async () => {
    const context = await setup();
    const guests = await context.organiser.client.events.classes.define.mutate(
      granted(context.event),
    );
    await context.organiser.client.events.zones.addSeatPositions.mutate({
      event: context.event,
      zone: context.seated,
      positions: ["C-14"],
    });
    const seat = (position: string): IssueGrantedInput => ({
      event: context.event,
      class: guests.id,
      zone: context.seated,
      placement: { kind: "Seated", position },
      holder: holderAccount(),
    });

    const { ticket } = await context.organiser.client.events.tickets.issueGranted.mutate(
      seat("C-14"),
    );
    expect((await ticketOnLedger(ticket)).placement).toEqual({
      kind: "Seated",
      position: positionOf("C-14"),
    });

    const sponsoredBefore = harness.sponsored.length;
    const recordsBefore = await rowCounts();
    for (const position of ["c14", "C14", "D-1"]) {
      expect(
        await refusal(() =>
          context.organiser.client.events.tickets.issueGranted.mutate(seat(position)),
        ),
      ).toEqual({ code: "BAD_REQUEST", errorCode: null });
    }
    expect(harness.sponsored.length).toBe(sponsoredBefore);
    expect(await rowCounts()).toEqual(recordsBefore);
  });

  it("ERR-TicketIdExists: the same seat twice is refused, and the refusal takes no quota place", async () => {
    const context = await setup();
    const guests = await context.organiser.client.events.classes.define.mutate(
      granted(context.event, { quota: 2 }),
    );
    await context.organiser.client.events.zones.addSeatPositions.mutate({
      event: context.event,
      zone: context.seated,
      positions: ["A-1", "A-2", "A-3"],
    });
    const seat = (position: string): IssueGrantedInput => ({
      event: context.event,
      class: guests.id,
      zone: context.seated,
      placement: { kind: "Seated", position },
      holder: holderAccount(),
    });

    await context.organiser.client.events.tickets.issueGranted.mutate(seat("A-1"));
    expect(
      await refusal(() => context.organiser.client.events.tickets.issueGranted.mutate(seat("A-1"))),
    ).toEqual({ code: "CONFLICT", errorCode: "ERR-TicketIdExists" });
    // The refused issuance freed its place in the quota: one more seat issues, then the quota holds.
    await context.organiser.client.events.tickets.issueGranted.mutate(seat("A-2"));
    expect(
      await refusal(() => context.organiser.client.events.tickets.issueGranted.mutate(seat("A-3"))),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-ClassQuotaExceeded" });
  });

  it("the ledger's verdict on a seat in an unseated zone is passed on", async () => {
    const context = await setup();
    const guests = await context.organiser.client.events.classes.define.mutate(
      granted(context.event),
    );

    expect(
      await refusal(() =>
        context.organiser.client.events.tickets.issueGranted.mutate({
          event: context.event,
          class: guests.id,
          zone: context.unseated,
          placement: { kind: "Seated", position: "A-1" },
          holder: holderAccount(),
        }),
      ),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-ZoneKindMismatch" });
  });

  it("refuses a Purchased class: its tickets are sold through checkout, never granted", async () => {
    const context = await setup();
    const general = await context.organiser.client.events.classes.define.mutate(
      granted(context.event, { provenance: "Purchased" }),
    );
    const sponsoredBefore = harness.sponsored.length;

    expect(
      await refusal(() =>
        context.organiser.client.events.tickets.issueGranted.mutate(
          unseatedTicket(context, general.id),
        ),
      ),
    ).toEqual({ code: "BAD_REQUEST", errorCode: null });
    expect(harness.sponsored.length).toBe(sponsoredBefore);
  });

  it("ERR-NotOwner: only the event's organiser issues its granted tickets", async () => {
    const context = await setup();
    const guests = await context.organiser.client.events.classes.define.mutate(
      granted(context.event),
    );
    const other = await harness.organiser();

    expect(
      await refusal(() =>
        other.client.events.tickets.issueGranted.mutate(unseatedTicket(context, guests.id)),
      ),
    ).toEqual({ code: "FORBIDDEN", errorCode: "ERR-NotOwner" });
  });
});
