import { randomBytes } from "node:crypto";
import { classLocator, eventLocator } from "@kippurocks/metadata-schema";
import { type Command, LOG_START, type LogRecord, type TicketId } from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeWithStore } from "../support/database.js";
import { type EventsHarness, eventsHarness, randomId } from "../support/events.js";

describeWithStore("metadata locators at event creation and issuance", () => {
  let harness: EventsHarness;

  beforeAll(async () => {
    harness = await eventsHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  /** The ledger's log, read through the SDK. */
  async function logRecords(): Promise<LogRecord[]> {
    const records: LogRecord[] = [];
    let cursor = LOG_START;
    for (;;) {
      const page = await harness.ledger.log.read(cursor, 100);
      if (!page.ok) throw new Error(page.error.code);
      if (page.value.records.length === 0) return records;
      records.push(...page.value.records);
      cursor = page.value.next;
    }
  }

  /** The command recorded at a receipt's cursor. */
  async function commandAt<Kind extends Command["kind"]>(
    cursor: string,
    kind: Kind,
  ): Promise<Extract<Command, { kind: Kind }>> {
    const record = (await logRecords()).find((candidate) => candidate.cursor === cursor);
    if (record === undefined || !("command" in record.entry)) {
      throw new Error(`no command recorded at ${cursor}`);
    }
    expect(record.entry.command.kind).toBe(kind);
    return record.entry.command as Extract<Command, { kind: Kind }>;
  }

  it("REQ-MD-1: createEvent carries the event's locator, named by its id, to the ledger", async () => {
    const organiser = await harness.organiser();
    const { event, cursor } = await organiser.client.events.create.mutate({
      zones: [{ id: randomId(), kind: "Unseated" }],
      capacity: null,
    });

    const command = await commandAt(cursor, "createEvent");
    expect(command.metadata).toBe(`https://meta.kippu.rocks/v0/events/${event}.json`);
    expect(command.metadata).toBe(eventLocator(event));

    // Kippu keeps the locator the ledger holds, so edits write where it points.
    const link = await harness.database.store.query(
      "SELECT metadata_locator FROM organiser_events WHERE event = $1",
      [event],
    );
    expect(link.rows).toEqual([{ metadata_locator: eventLocator(event) }]);
  });

  it("REQ-MD-1: every event gets a locator of its own", async () => {
    const organiser = await harness.organiser();
    const zones = [{ id: randomId(), kind: "Unseated" as const }];
    const first = await organiser.client.events.create.mutate({ zones, capacity: null });
    const second = await organiser.client.events.create.mutate({ zones, capacity: null });
    const locators = [
      (await commandAt(first.cursor, "createEvent")).metadata,
      (await commandAt(second.cursor, "createEvent")).metadata,
    ];
    expect(locators).toEqual([eventLocator(first.event), eventLocator(second.event)]);
    expect(new Set(locators).size).toBe(2);
  });

  it("AD-22: tickets need no documents — issuance records no locator, and the class's is derived", async () => {
    const organiser = await harness.organiser();
    const zone = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: zone, kind: "Unseated" }],
      capacity: null,
    });
    const guests = await organiser.client.events.classes.define.mutate({
      event,
      name: "Guest list",
      description: null,
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: false, cannotTransfer: false },
      quota: null,
    });

    const derived: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const { ticket, cursor } = await organiser.client.events.tickets.issueGranted.mutate({
        event,
        class: guests.id,
        zone,
        placement: { kind: "Unseated" },
        holder: randomBytes(32).toString("hex"),
      });
      const command = await commandAt(cursor, "issueTicket");
      expect(command.metadata).toBeNull();

      // A client holding only the ticket derives its class document's locator.
      const onLedger = await harness.ledger.getTicket(ticket as TicketId);
      if (!onLedger.ok) throw new Error(onLedger.error.code);
      derived.push(classLocator(onLedger.value.class));
    }
    expect(derived).toEqual(Array(3).fill(`https://meta.kippu.rocks/v0/classes/${guests.id}.json`));
  });
});
