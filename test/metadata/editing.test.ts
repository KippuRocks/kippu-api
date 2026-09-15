import { readFile } from "node:fs/promises";
import {
  CLASS_SCHEMA_ID,
  classLocator,
  EVENT_SCHEMA_ID,
  eventLocator,
} from "@kippurocks/metadata-schema";
import { type Cursor, LOG_START, type LogRecord } from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildMetadataEdge } from "../../src/metadata/edge.js";
import type { MetadataStorage } from "../../src/metadata/storage.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  refusal,
  type TestOrganiser,
} from "../support/events.js";
import { memoryMetadataStorage } from "../support/object-storage.js";

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(
      new URL(`../../packages/metadata-schema/test/fixtures/${name}`, import.meta.url),
      "utf8",
    ),
  );
}

describeWithStore("organisers editing metadata documents", () => {
  let harness: EventsHarness;
  let storage: MetadataStorage;

  beforeAll(async () => {
    storage = memoryMetadataStorage();
    harness = await eventsHarness({ metadataStorage: storage });
  });

  afterAll(async () => {
    await harness.close();
  });

  /** Every record in the ledger's log, read through the SDK. */
  async function logRecords(): Promise<LogRecord[]> {
    const records: LogRecord[] = [];
    let cursor: Cursor = LOG_START;
    for (;;) {
      const page = await harness.ledger.log.read(cursor, 100);
      if (!page.ok) throw new Error(page.error.code);
      if (page.value.records.length === 0) return records;
      records.push(...page.value.records);
      cursor = page.value.next;
    }
  }

  async function auditRows(): Promise<number> {
    const counted = await harness.database.store.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log",
    );
    return counted.rows[0]?.n ?? 0;
  }

  /** The document stored at a locator, parsed. */
  async function stored(locator: string): Promise<unknown> {
    const object = await storage.get(new URL(locator).pathname.slice(1));
    if (object === null) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  async function eventOf(organiser: TestOrganiser) {
    const zone = randomId();
    const { event, cursor } = await organiser.client.events.create.mutate({
      zones: [{ id: zone, kind: "Unseated" }],
      capacity: null,
    });
    return { event, cursor, zone };
  }

  async function eventDocument(event: string, description: string) {
    return { ...(await fixture("event.json")), eventId: event, description };
  }

  it("AC-A3.1: editing an event's description causes no ledger write", async () => {
    const organiser = await harness.organiser();
    const { event } = await eventOf(organiser);
    const first = await organiser.client.metadata.events.put.mutate({
      event,
      document: await eventDocument(event, "An evening of chamber music."),
    });

    const logBefore = await logRecords();
    const auditBefore = await auditRows();

    const edited = await eventDocument(event, "An evening of chamber music, with an encore.");
    const second = await organiser.client.metadata.events.put.mutate({ event, document: edited });

    // Nothing reached the ledger: its log is exactly what it was, and Kippu relayed nothing.
    expect(await logRecords()).toEqual(logBefore);
    expect(await auditRows()).toBe(auditBefore);

    // The document changed; its locator — the one on the ledger — did not (REQ-MD-1).
    expect(second.locator).toBe(first.locator);
    expect(second.locator).toBe(eventLocator(event));
    expect(second.etag).not.toBe(first.etag);
    expect(await stored(second.locator)).toEqual(edited);
    const creation = logBefore.find(
      (record) =>
        "command" in record.entry &&
        record.entry.command.kind === "createEvent" &&
        record.entry.command.event === event,
    );
    expect(creation?.entry).toMatchObject({ command: { metadata: second.locator } });
  });

  it("REQ-MD-4: the edited document is served at its locator, with no credentials, to any origin", async () => {
    const organiser = await harness.organiser();
    const { event } = await eventOf(organiser);
    const document = await eventDocument(event, "Served publicly.");
    const { locator, etag } = await organiser.client.metadata.events.put.mutate({
      event,
      document,
    });

    const edge = buildMetadataEdge({ storage });
    try {
      const response = await edge.inject({
        method: "GET",
        url: new URL(locator).pathname,
        headers: { origin: "https://any-ticketto-client.example" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["content-type"]).toMatch(/^application\/json/);
      expect(response.headers.etag).toBe(etag);
      expect(JSON.parse(response.body)).toEqual(document);
    } finally {
      await edge.close();
    }
  });

  it("writes a class's document at the locator derived from its class id, with no ledger write", async () => {
    const organiser = await harness.organiser();
    const { event } = await eventOf(organiser);
    const guests = await organiser.client.events.classes.define.mutate({
      event,
      name: "Press",
      description: null,
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: true, cannotTransfer: true },
      quota: 20,
    });
    const logBefore = await logRecords();
    const document = {
      ...(await fixture("class.json")),
      classId: guests.id,
      eventId: event,
      name: "Press",
    };

    const written = await organiser.client.metadata.classes.put.mutate({
      event,
      class: guests.id,
      document,
    });

    expect(written.locator).toBe(classLocator(guests.id));
    expect(await stored(written.locator)).toEqual(document);
    expect(await logRecords()).toEqual(logBefore);
  });

  it("REQ-MD-4: a document that does not conform to its schema is refused, and nothing is stored", async () => {
    const organiser = await harness.organiser();
    const { event } = await eventOf(organiser);
    const valid = await eventDocument(event, "Valid.");
    const cases = [
      // NFR-6: a field the closed schema does not declare, such as a personal one.
      { ...valid, contactEmail: "someone@example.invalid" },
      { ...valid, name: "" },
      { ...valid, $schema: EVENT_SCHEMA_ID.replace("/1.0.json", "/9.0.json") },
      { ...valid, $schema: CLASS_SCHEMA_ID },
      { ...valid, eventId: randomId() },
    ];
    for (const document of cases) {
      expect(
        await refusal(() => organiser.client.metadata.events.put.mutate({ event, document })),
      ).toEqual({ code: "BAD_REQUEST", errorCode: null });
    }
    expect(await stored(eventLocator(event))).toBeNull();
  });

  it("only the event's owner edits its documents", async () => {
    const owner = await harness.organiser();
    const other = await harness.organiser();
    const { event } = await eventOf(owner);
    const document = await eventDocument(event, "Not yours.");

    expect(
      await refusal(() => other.client.metadata.events.put.mutate({ event, document })),
    ).toEqual({ code: "FORBIDDEN", errorCode: "ERR-NotOwner" });
    expect(
      await refusal(() =>
        owner.client.metadata.classes.put.mutate({
          event,
          class: randomId(),
          document: { $schema: CLASS_SCHEMA_ID },
        }),
      ),
    ).toMatchObject({ errorCode: "ERR-UnknownClass" });
    expect(await stored(eventLocator(event))).toBeNull();
  });
});
