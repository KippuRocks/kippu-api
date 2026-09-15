import { randomBytes } from "node:crypto";
import type { AccountId, ClassId, EventId, TicketId, ZoneId } from "@ticketto/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IssueGrantedInput } from "../../src/events/ports.js";
import { normaliseDesignation, positionOf } from "../../src/events/zones.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  refusal,
  type TestOrganiser,
} from "../support/events.js";

// Store-backed: generous timeouts, so a loaded CI host or database does not fail the suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const holderAccount = () => randomBytes(32).toString("hex");

/** `Ć` as one code point, and as `C` followed by a combining acute accent. */
const PRECOMPOSED = "Ć-1";
const DECOMPOSED = "Ć-1";

describe("seat designations", () => {
  it("are normalised to NFC, keeping case and punctuation", () => {
    expect(normaliseDesignation(DECOMPOSED)).toBe(PRECOMPOSED);
    expect(positionOf(DECOMPOSED)).toBe(positionOf(PRECOMPOSED));
    expect(positionOf("C-14")).not.toBe(positionOf("c14"));
  });
});

describeWithStore("the seated double-allocation pre-check", () => {
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
    readonly press: string;
    readonly staff: string;
  }

  async function setup(positions: readonly string[]): Promise<Setup> {
    const organiser = await harness.organiser();
    const seated = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: seated, kind: "Seated" }],
      capacity: null,
    });
    await organiser.client.events.zones.addSeatPositions.mutate({ event, zone: seated, positions });
    const define = (name: string) =>
      organiser.client.events.classes.define.mutate({
        event,
        name,
        description: null,
        provenance: "Granted",
        policy: { kind: "Single" },
        restrictions: { cannotResale: false, cannotTransfer: false },
        quota: null,
      });
    return {
      organiser,
      event,
      seated,
      press: (await define("Press")).id,
      staff: (await define("Staff")).id,
    };
  }

  const seat = (context: Setup, position: string, classId = context.press): IssueGrantedInput => ({
    event: context.event,
    class: classId,
    zone: context.seated,
    placement: { kind: "Seated", position },
    holder: holderAccount(),
  });

  /** What issuing would leave behind: audit rows, issuance records, and sponsorships. */
  async function traces() {
    const count = async (sql: string) =>
      Number((await harness.database.store.query<{ n: string }>(sql)).rows[0]?.n);
    return {
      audited: await count(
        "SELECT count(*) AS n FROM audit_log WHERE command_kind = 'issueTicket'",
      ),
      recorded: await count("SELECT count(*) AS n FROM granted_issuances"),
      sponsored: harness.sponsored.length,
    };
  }

  it("AC-B5.2: a comprehensible error before submission", async () => {
    const context = await setup(["C-14"]);
    await context.organiser.client.events.tickets.issueGranted.mutate(seat(context, "C-14"));
    const before = await traces();

    // The same seat, from another class: refused by Kippu, naming why, with nothing signed.
    expect(
      await refusal(() =>
        context.organiser.client.events.tickets.issueGranted.mutate(
          seat(context, "C-14", context.staff),
        ),
      ),
    ).toEqual({ code: "CONFLICT", errorCode: "ERR-TicketIdExists" });
    expect(await traces()).toEqual(before);
  });

  it("AC-B5.2: a seat the ledger holds a ticket for is refused before submission, whoever issued it", async () => {
    const context = await setup(["C-15"]);
    // Issued straight through the SDK with the organiser's authority: Kippu keeps no record of it.
    const account = await harness.authority.account(context.organiser.organiserId);
    const direct = await harness.authority.relay(
      context.organiser.organiserId,
      context.organiser.request,
      (signer) =>
        harness.ledger.issueTicket(signer, {
          event: context.event as EventId,
          zone: context.seated as ZoneId,
          placement: { kind: "Seated", position: positionOf("C-15") },
          class: context.press as ClassId,
          provenance: "Granted",
          policy: { kind: "Single" },
          restrictions: { cannotResale: false, cannotTransfer: false },
          holder: account as AccountId,
          metadata: null,
        }),
    );
    expect(await direct.submission).toMatchObject({ ok: true });
    const before = await traces();

    expect(
      await refusal(() =>
        context.organiser.client.events.tickets.issueGranted.mutate(seat(context, "C-15")),
      ),
    ).toEqual({ code: "CONFLICT", errorCode: "ERR-TicketIdExists" });
    expect(await traces()).toEqual(before);
  });

  it("AC-B5.2: concurrent issuances of one seat submit once, and the rest are refused before submission", async () => {
    const context = await setup(["D-1"]);
    const before = await traces();

    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        context.organiser.client.events.tickets.issueGranted.mutate(
          seat(context, "D-1", index % 2 === 0 ? context.press : context.staff),
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    for (const outcome of outcomes.filter((o) => o.status === "rejected")) {
      expect((outcome.reason as { data?: { errorCode?: string } }).data?.errorCode).toBe(
        "ERR-TicketIdExists",
      );
    }
    const after = await traces();
    expect(after.audited - before.audited).toBe(1);
    expect(after.sponsored - before.sponsored).toBe(1);
    expect(await harness.ledger.getEvent(context.event as EventId)).toMatchObject({
      ok: true,
      value: { issued: 1 },
    });
  });

  it("REQ-ID-3: visually identical designations are one seat, stored and derived in NFC", async () => {
    const context = await setup([DECOMPOSED, PRECOMPOSED]);

    expect(
      await context.organiser.client.events.zones.seatPositions.query({
        event: context.event,
        zone: context.seated,
      }),
    ).toMatchObject({ positions: [PRECOMPOSED] });

    const { ticket } = await context.organiser.client.events.tickets.issueGranted.mutate(
      seat(context, DECOMPOSED),
    );
    const onLedger = await harness.ledger.getTicket(ticket as TicketId);
    expect(onLedger).toMatchObject({
      ok: true,
      value: { placement: { kind: "Seated", position: positionOf(PRECOMPOSED) } },
    });
    expect(positionOf(PRECOMPOSED)).toBe(Buffer.from(PRECOMPOSED, "utf8").toString("hex"));

    // The other spelling is the same seat, already issued.
    expect(
      await refusal(() =>
        context.organiser.client.events.tickets.issueGranted.mutate(
          seat(context, PRECOMPOSED, context.staff),
        ),
      ),
    ).toEqual({ code: "CONFLICT", errorCode: "ERR-TicketIdExists" });
  });

  it("is a service function every allocation of a seat can call", async () => {
    const context = await setup(["E-1"]);
    const { seats } = harness.events;
    const position = positionOf("E-1");

    const free = await seats.assertFree(
      harness.database.store,
      context.event,
      context.seated,
      position,
    );
    expect(free).toBe(seats.ticketOf(context.event, context.seated, position));

    const { ticket } = await context.organiser.client.events.tickets.issueGranted.mutate(
      seat(context, "E-1"),
    );
    expect(ticket).toBe(free);
    await expect(
      seats.assertFree(harness.database.store, context.event, context.seated, position),
    ).rejects.toMatchObject({ code: "ERR-TicketIdExists" });
  });
});
