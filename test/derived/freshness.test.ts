import {
  type AccountId,
  type Authorisation,
  type Discriminator,
  type EventId,
  LOG_START,
  type OperationId,
  type TicketId,
} from "@ticketto/sdk";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createFreshness, type Freshness } from "../../src/derived/freshness.js";
import { ledgerFactsProjection } from "../../src/derived/ledger-facts.js";
import { createDerivedQueries } from "../../src/derived/queries.js";
import { createDerivedReader, type DerivedReaderOptions } from "../../src/derived/reader.js";
import { createStore } from "../../src/store/store.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { scriptedLog, wholeLog } from "../support/derived.js";
import {
  classId,
  type MemoryLedger,
  memoryLedger,
  settled,
  zoneId,
} from "../support/memory-ledger.js";

const hex = (length: number, byte: number) => byte.toString(16).padStart(2, "0").repeat(length);

/** Long enough that only a hint or a notification can be what woke anything. */
const NEVER = 60_000;

describeWithStore("waitFor and freshness", () => {
  let database: TestDatabase;
  let ledger: MemoryLedger;
  let cleanups: (() => Promise<void>)[];

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    ledger = memoryLedger();
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await database.drop();
  });

  function reader(options: Partial<DerivedReaderOptions> = {}) {
    const created = createDerivedReader({
      store: database.store,
      log: ledger.kippu.log,
      projections: [ledgerFactsProjection(ledger.kippu)],
      pollInterval: NEVER,
      onError: () => {},
      ...options,
    });
    cleanups.push(() => created.stop());
    return created;
  }

  function freshness(store = database.store, pollInterval = NEVER): Freshness {
    const created = createFreshness({ store, pollInterval });
    cleanups.push(() => created.close());
    return created;
  }

  /** An organiser, a holder, and an event with one unseated zone. */
  async function setUp() {
    await ledger.registerOrganiser();
    const holder = await ledger.registerHolder(0x21);
    const event = await ledger.createEvent(0x01, [zoneId(0x7a)]);
    return { holder: holder.account, event };
  }

  it("NFR-11: a newly issued ticket's holder is visible right after waitFor resolves", async () => {
    const { holder, event } = await setUp();
    const copy = reader();
    copy.start();
    const fresh = freshness();

    // Written straight to the ledger; Kippu learns of it only through the log.
    const issued = ledger.direct.issueTicket(ledger.organiser.signer, {
      event,
      zone: zoneId(0x7a),
      placement: { kind: "Unseated", discriminator: hex(16, 0x01) as Discriminator },
      class: classId(0xc1),
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: false, cannotTransfer: false },
      holder,
      metadata: null,
    });
    const receipt = await settled(issued.submission);

    expect(await fresh.waitFor(receipt.cursor, 5_000)).toBe(true);
    const read = await createDerivedQueries(database.store).ticket(issued.id);
    expect(read.result?.value.holder).toBe(holder);
    expect(read.freshness.cursor).toBe(receipt.cursor);
  });

  it("NFR-11: a transfer's new holder is visible right after waitFor resolves", async () => {
    // The M1 ledger rules do not accept transfers yet (`T-008-08`, M4), so the
    // transfer record is appended to a log that otherwise is backend-memory's own.
    const { holder, event } = await setUp();
    const ticket = await ledger.issue(event, zoneId(0x7a), 1, holder);
    const prefix = (await wholeLog(ledger.kippu.log)).map(({ cursor: _, ...record }) => record);
    const scripted = scriptedLog(prefix);
    const copy = reader({ log: scripted.log, pollInterval: 20 });
    copy.start();
    const fresh = freshness();
    const receiver = hex(32, 0x42) as AccountId;

    const cursor = scripted.append({
      recordedAt: (prefix.at(-1)?.recordedAt ?? 0) + 1,
      event: { id: event, sequence: prefix.filter((r) => r.event?.id === event).length },
      entry: {
        command: {
          kind: "transferTicket",
          operationId: hex(16, 0xa1) as OperationId,
          expiresAt: 1_900_000_000_000,
          event,
          ticket,
          receiver,
        },
        authorisation: new Uint8Array(0) as Authorisation,
      },
      presentedAt: null,
    });

    expect(await fresh.waitFor(cursor, 5_000)).toBe(true);
    const queries = createDerivedQueries(database.store);
    const read = await queries.ticket(ticket);
    expect(read.result?.value.holder).toBe(receiver);
    expect(read.freshness).toMatchObject({ cursor, records: prefix.length + 1 });
    expect((await queries.holdings(receiver)).result.map((held) => held.value.id)).toEqual([
      ticket,
    ]);
    expect((await queries.holdings(holder)).result).toEqual([]);
  });

  it("a waiter in another process is woken by the batch's notification, not by polling", async () => {
    const { holder, event } = await setUp();
    await reader().catchUp();
    const ticket = ledger.direct.issueTicket(ledger.organiser.signer, {
      event,
      zone: zoneId(0x7a),
      placement: { kind: "Unseated", discriminator: hex(16, 0x02) as Discriminator },
      class: classId(0xc1),
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: false, cannotTransfer: false },
      holder,
      metadata: null,
    });
    const receipt = await settled(ticket.submission);

    // Its own connection pool, as a separate API process would have.
    const elsewhere = createStore(database.url);
    cleanups.push(() => elsewhere.end());
    const fresh = freshness(elsewhere, NEVER);
    const started = Date.now();
    const waiting = fresh.waitFor(receipt.cursor, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 200));

    await reader().catchUp();
    expect(await waiting).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("resolves false when the copy does not reach the cursor in time", async () => {
    await setUp();
    const [last] = (await wholeLog(ledger.kippu.log)).slice(-1);
    const fresh = freshness(database.store, 20);
    expect(await fresh.waitFor(last?.cursor ?? LOG_START, 100)).toBe(false);
  });

  it("resolves at once for a cursor already reflected, and for the start of the log", async () => {
    await setUp();
    await reader().catchUp();
    const records = await wholeLog(ledger.kippu.log);
    const fresh = freshness();
    const started = Date.now();
    expect(await fresh.waitFor(records[0]?.cursor ?? LOG_START, 5_000)).toBe(true);
    expect(await fresh.waitFor(LOG_START, 0)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("every read response says how far the copy had read, hit or miss", async () => {
    const queries = createDerivedQueries(database.store);
    const unknownEvent = hex(32, 0x99) as EventId;
    const empty = { cursor: LOG_START, records: 0, lastRecordedAt: null };
    expect(await queries.event(unknownEvent)).toEqual({ result: null, freshness: empty });
    expect(await queries.holdings(hex(32, 0x98) as AccountId)).toEqual({
      result: [],
      freshness: empty,
    });

    const { event } = await setUp();
    await reader().catchUp();
    const records = await wholeLog(ledger.kippu.log);
    const head = {
      cursor: records.at(-1)?.cursor,
      records: records.length,
      lastRecordedAt: records.at(-1)?.recordedAt,
    };
    expect((await queries.event(event)).freshness).toEqual(head);
    expect((await queries.ticket(hex(32, 0x97) as TicketId)).freshness).toEqual(head);
    expect((await queries.attendance(hex(32, 0x97) as TicketId)).freshness).toEqual(head);
    expect(await freshness().current()).toEqual(head);
  });
});
