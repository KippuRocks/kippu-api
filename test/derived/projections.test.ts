import type {
  AccountId,
  Authorisation,
  Command,
  EventId,
  LogReader,
  LogRecord,
  OperationId,
  PassId,
  Position,
  TicketId,
  Ticketto,
} from "@ticketto/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LedgerQueryError,
  ledgerFactsProjection,
  UnprojectableRecordError,
} from "../../src/derived/ledger-facts.js";
import { createDerivedQueries } from "../../src/derived/queries.js";
import { createDerivedReader } from "../../src/derived/reader.js";
import type { Store } from "../../src/store/store.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { derivedSnapshot, scriptedLog, wholeLog } from "../support/derived.js";
import {
  classId,
  type MemoryLedger,
  memoryLedger,
  settled,
  zoneId,
} from "../support/memory-ledger.js";

const hex = (length: number, byte: number) => byte.toString(16).padStart(2, "0").repeat(length);
/** A seat designation: variable-length bytes, carried as hex. */
const seatLabel = (label: string) => Buffer.from(label).toString("hex") as Position;

/** The projections' answers, without the freshness each read carries (see freshness.test.ts). */
function resultsOf(store: Store) {
  const queries = createDerivedQueries(store);
  return {
    event: async (id: EventId) => (await queries.event(id)).result,
    ticket: async (id: TicketId) => (await queries.ticket(id)).result,
    holdings: async (account: AccountId) => (await queries.holdings(account)).result,
    attendance: async (ticket: TicketId) => (await queries.attendance(ticket)).result,
  };
}

describeWithStore("the derived copy's projections", () => {
  let databases: TestDatabase[];
  let ledger: MemoryLedger;

  async function database(): Promise<TestDatabase> {
    const created = await createMigratedTestDatabase();
    databases.push(created);
    return created;
  }

  function reader(store: Store, log: LogReader, reads: Pick<Ticketto, "getEvent">, batchSize = 3) {
    return createDerivedReader({
      store,
      log,
      projections: [ledgerFactsProjection(reads)],
      batchSize,
      onError: () => {},
    });
  }

  beforeEach(() => {
    databases = [];
    ledger = memoryLedger();
  });

  afterEach(async () => {
    for (const created of databases) await created.drop();
  });

  /**
   * A ledger history written entirely by a client of `backend-memory`, never
   * through Kippu: seated and unseated zones, a zone added and one removed,
   * granted and purchased tickets, every policy, and restrictions the ledger
   * normalises.
   */
  async function directHistory() {
    const { direct, organiser } = ledger;
    await ledger.registerOrganiser();
    const alice = await ledger.registerHolder(0x21);
    const bob = await ledger.registerHolder(0x22);

    const stalls = zoneId(0x51);
    const floor = zoneId(0x52);
    const balcony = zoneId(0x53);
    const concert = direct.createEvent(organiser.signer, {
      salt: new Uint8Array(16).fill(0x01),
      zones: [
        { id: stalls, kind: "Seated" },
        { id: floor, kind: "Unseated" },
      ],
      capacity: 10,
      metadata: null,
    });
    await settled(concert.submission);
    await settled(
      direct.addZone(organiser.signer, {
        event: concert.id,
        zone: { id: balcony, kind: "Seated" },
      }),
    );
    await settled(direct.removeZone(organiser.signer, { event: concert.id, zone: floor }));

    const seat = direct.issueTicket(organiser.signer, {
      event: concert.id,
      zone: stalls,
      placement: { kind: "Seated", position: seatLabel("A-12") },
      class: classId(0xc1),
      provenance: "Purchased",
      policy: { kind: "Multiple", max: 3, until: 1_900_000_000_000 },
      restrictions: { cannotResale: false, cannotTransfer: false },
      holder: alice.account,
      metadata: null,
    });
    await settled(seat.submission);
    const press = direct.issueTicket(organiser.signer, {
      event: concert.id,
      zone: balcony,
      placement: { kind: "Seated", position: seatLabel("P-1") },
      class: classId(0xc2),
      provenance: "Granted",
      policy: { kind: "Unlimited", until: null },
      // The ledger records `cannotResale` as well (`REQ-TK-2`).
      restrictions: { cannotResale: false, cannotTransfer: true },
      holder: bob.account,
      metadata: null,
    });
    await settled(press.submission);

    const festival = await ledger.createEvent(0x02, [zoneId(0x61)]);
    const general = await ledger.issue(festival, zoneId(0x61), 1, alice.account);

    return {
      events: [concert.id, festival],
      tickets: [seat.id, press.id, general],
      holders: { alice: alice.account, bob: bob.account },
    };
  }

  it("NFR-11: writes made directly through backend-memory, bypassing Kippu, appear in projections", async () => {
    const { events, tickets, holders } = await directHistory();
    const { store } = await database();
    const records = await wholeLog(ledger.kippu.log);

    expect(await reader(store, ledger.kippu.log, ledger.kippu).catchUp()).toBe(records.length);
    // Kippu relayed none of it.
    const relayed = await store.query("SELECT count(*)::int AS n FROM audit_log");
    expect(relayed.rows[0]).toEqual({ n: 0 });

    const queries = resultsOf(store);
    const lastRecordOf = (event: EventId) => records.findLastIndex((r) => r.event?.id === event);

    for (const id of events) {
      const ledgerEvent = await ledger.kippu.getEvent(id);
      expect(ledgerEvent.ok).toBe(true);
      expect(await queries.event(id)).toEqual({
        value: ledgerEvent.ok ? ledgerEvent.value : null,
        sequence: lastRecordOf(id),
        authoritative: false,
      });
    }
    for (const id of tickets) {
      const ledgerTicket = await ledger.kippu.getTicket(id);
      expect(ledgerTicket.ok).toBe(true);
      const copy = await queries.ticket(id);
      expect(copy?.value).toEqual(ledgerTicket.ok ? ledgerTicket.value : null);
      expect(copy?.authoritative).toBe(false);
      expect(copy?.sequence).toBe(
        records.findIndex(
          (r) =>
            "command" in r.entry && "ticket" in r.entry.command && r.entry.command.ticket === id,
        ),
      );
    }

    const concert = await queries.event(events[0] as EventId);
    expect(concert?.value).toMatchObject({ issued: 2, maxCapacity: 10, status: "Active" });
    expect(concert?.value.zones.map((zone) => zone.id)).toEqual([zoneId(0x51), zoneId(0x53)]);
    expect((await queries.ticket(tickets[1] as TicketId))?.value.restrictions).toEqual({
      cannotResale: true,
      cannotTransfer: true,
    });

    const aliceHoldings = await queries.holdings(holders.alice);
    expect(aliceHoldings.map((held) => held.value.id).sort()).toEqual(
      [tickets[0], tickets[2]].sort(),
    );
    expect(aliceHoldings.map((held) => held.value.event)).toEqual(
      aliceHoldings.map((held) => held.value.event).sort(),
    );
    expect((await queries.holdings(holders.bob)).map((held) => held.value.id)).toEqual([
      tickets[1],
    ]);
    expect(await queries.holdings(hex(32, 0xee) as AccountId)).toEqual([]);
    expect(await queries.attendance(tickets[0] as TicketId)).toBeNull();
  });

  it("NFR-11: a write made after the copy caught up appears on the next pull", async () => {
    const { events, holders } = await directHistory();
    const { store } = await database();
    const copy = reader(store, ledger.kippu.log, ledger.kippu);
    await copy.catchUp();

    const festival = events[1] as EventId;
    const late = await ledger.issue(festival, zoneId(0x61), 2, holders.bob);
    expect(await resultsOf(store).ticket(late)).toBeNull();

    expect(await copy.catchUp()).toBe(1);
    const queries = resultsOf(store);
    expect((await queries.ticket(late))?.value.holder).toBe(holders.bob);
    expect((await queries.event(festival))?.value.issued).toBe(2);
  });

  describe("effects of inputs the M1 rules do not accept yet", () => {
    const authorisation = new Uint8Array(0) as Authorisation;
    const envelope = (n: number) => ({
      operationId: hex(16, n) as OperationId,
      expiresAt: 1_900_000_000_000,
    });

    /** The direct history's log, followed by records the ledger's rules cannot produce until M3 and M4. */
    async function extendedLog() {
      const history = await directHistory();
      const prefix = (await wholeLog(ledger.kippu.log)).map(({ cursor: _, ...record }) => record);
      const [concert] = history.events as [EventId];
      const [seat, press] = history.tickets as [TicketId, TicketId];
      let eventSequence = prefix.filter((r) => r.event?.id === concert).length;
      let recordedAt = (prefix.at(-1)?.recordedAt ?? 0) + 1_000;
      const command = (c: Command): Omit<LogRecord, "cursor"> => ({
        recordedAt: recordedAt++,
        event: { id: concert, sequence: eventSequence++ },
        entry: { command: c, authorisation },
        presentedAt: null,
      });
      const pass = (
        id: number,
        ticket: TicketId,
        holder: AccountId,
      ): Omit<LogRecord, "cursor"> => ({
        recordedAt: recordedAt++,
        event: { id: concert, sequence: eventSequence++ },
        entry: {
          pass: {
            ticket,
            holder,
            id: hex(16, id) as PassId,
            notBefore: recordedAt - 30_000,
            notAfter: recordedAt + 30_000,
          },
          authorisation,
        },
        presentedAt: recordedAt - 500,
      });
      const tail = [
        command({
          kind: "setEventCapacity",
          ...envelope(0xa1),
          event: concert,
          capacity: 4,
          proof: null,
        }),
        pass(0xb1, seat, history.holders.alice),
        command({
          kind: "removeRestriction",
          ...envelope(0xa2),
          event: concert,
          ticket: press,
          restriction: "cannotTransfer",
        }),
        command({
          kind: "transferTicket",
          ...envelope(0xa3),
          event: concert,
          ticket: seat,
          receiver: history.holders.bob,
        }),
        pass(0xb2, seat, history.holders.bob),
        command({ kind: "setEventStatus", ...envelope(0xa4), event: concert, status: "Sealed" }),
      ];
      return { history, ...scriptedLog([...prefix, ...tail]), prefixLength: prefix.length };
    }

    it("status, capacity, transfer, restriction removal and attendance", async () => {
      const { history, log, records, prefixLength } = await extendedLog();
      const [concert] = history.events as [EventId];
      const [seat, press] = history.tickets as [TicketId, TicketId];
      const { store } = await database();
      await reader(store, log, ledger.kippu).catchUp();
      const queries = resultsOf(store);

      expect(await queries.event(concert)).toMatchObject({
        value: { status: "Sealed", maxCapacity: 4, issued: 2 },
        sequence: prefixLength + 5,
      });
      expect(await queries.ticket(seat)).toMatchObject({
        value: { holder: history.holders.bob, attendances: 2 },
        sequence: prefixLength + 4,
      });
      expect(await queries.ticket(press)).toMatchObject({
        // Only the flag named is cleared (`INV-10`).
        value: { restrictions: { cannotResale: true, cannotTransfer: false } },
        sequence: prefixLength + 2,
      });
      expect(await queries.attendance(seat)).toEqual({
        value: {
          event: concert,
          ticket: seat,
          count: 2,
          lastRecordedAt: records[prefixLength + 4]?.recordedAt,
        },
        sequence: prefixLength + 4,
        authoritative: false,
      });
      expect(
        (await queries.holdings(history.holders.bob)).map((held) => held.value.id).sort(),
      ).toEqual([seat, press].sort());
    });

    it("NFR-11: rebuilding from cursor zero, in any batch size, yields identical projections", async () => {
      const { log } = await extendedLog();
      const one = await database();
      const other = await database();
      await reader(one.store, log, ledger.kippu, 1).catchUp();
      await reader(other.store, log, ledger.kippu, 100).catchUp();
      expect(await derivedSnapshot(one.store)).toEqual(await derivedSnapshot(other.store));
    });
  });

  it("a record the projections cannot apply stops the reader, and is never skipped", async () => {
    await ledger.registerOrganiser();
    const event = await ledger.createEvent(0x01);
    const prefix = (await wholeLog(ledger.kippu.log)).map(({ cursor: _, ...record }) => record);
    const beyondV0 = {
      recordedAt: 1,
      event: { id: event, sequence: 1 },
      entry: {
        command: {
          kind: "listTicket",
          ...{ operationId: hex(16, 1), expiresAt: 2 },
          event,
        } as unknown as Command,
        authorisation: new Uint8Array(0) as Authorisation,
      },
      presentedAt: null,
    };
    const { log } = scriptedLog([...prefix, beyondV0]);
    const { store } = await database();
    const copy = reader(store, log, ledger.kippu, 10);

    await expect(copy.step()).rejects.toBeInstanceOf(UnprojectableRecordError);
    expect(await copy.position()).toMatchObject({ nextSequence: 0 });
    expect(await resultsOf(store).event(event)).toBeNull();
  });

  it("a transfer of a ticket the copy does not hold stops the reader", async () => {
    await ledger.registerOrganiser();
    const event = await ledger.createEvent(0x01);
    const prefix = (await wholeLog(ledger.kippu.log)).map(({ cursor: _, ...record }) => record);
    const { log } = scriptedLog([
      ...prefix,
      {
        recordedAt: 1,
        event: { id: event, sequence: 1 },
        entry: {
          command: {
            kind: "transferTicket",
            operationId: hex(16, 1) as OperationId,
            expiresAt: 2,
            event,
            ticket: hex(32, 0x99) as TicketId,
            receiver: hex(32, 0x98) as AccountId,
          },
          authorisation: new Uint8Array(0) as Authorisation,
        },
        presentedAt: null,
      },
    ]);
    const { store } = await database();
    const copy = reader(store, log, ledger.kippu, 1);
    await copy.step();
    await copy.step();
    await expect(copy.step()).rejects.toBeInstanceOf(UnprojectableRecordError);
    expect(await copy.position()).toMatchObject({ nextSequence: 2 });
  });

  it("a point query the ledger cannot answer rolls the batch back, to be retried", async () => {
    await ledger.registerOrganiser();
    const event = await ledger.createEvent(0x01);
    const { store } = await database();
    let refusals = 1;
    const reads: Pick<Ticketto, "getEvent"> = {
      getEvent: (id) =>
        refusals-- > 0
          ? Promise.resolve({ ok: false, error: { code: "ERR-LedgerUnavailable" } })
          : ledger.kippu.getEvent(id),
    };
    const copy = reader(store, ledger.kippu.log, reads, 10);
    await expect(copy.step()).rejects.toBeInstanceOf(LedgerQueryError);
    expect(await copy.position()).toMatchObject({ nextSequence: 0 });
    expect(await copy.catchUp()).toBe(2);
    expect((await resultsOf(store).event(event))?.value.owner).toBe(
      ledger.organiser.signer.account,
    );
  });
});
