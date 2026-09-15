import { producePass } from "@ticketto/profile-v0";
import type {
  AccountId,
  ClassId,
  Discriminator,
  EventId,
  PassId,
  ProofId,
  TicketId,
} from "@ticketto/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ledgerFactsProjection } from "../../src/derived/ledger-facts.js";
import { createDerivedQueries } from "../../src/derived/queries.js";
import { createDerivedReader } from "../../src/derived/reader.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { derivedSnapshot, wholeLog } from "../support/derived.js";
import {
  classId,
  type MemoryLedger,
  memoryLedger,
  settled,
  zoneId,
} from "../support/memory-ledger.js";

// These tests create databases and write to a ledger: on a loaded machine that
// takes far longer than Vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const hex = (length: number, byte: number) => byte.toString(16).padStart(2, "0").repeat(length);

describeWithStore("projections on real logs of the M3 and M4 commands", () => {
  let database: TestDatabase;
  let ledger: MemoryLedger;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    ledger = memoryLedger();
  });

  afterEach(async () => {
    await database.drop();
  });

  const reader = (batchSize = 3) =>
    createDerivedReader({
      store: database.store,
      log: ledger.kippu.log,
      projections: [ledgerFactsProjection(ledger.kippu)],
      batchSize,
      onError: () => {},
    });

  /**
   * A history written straight to `backend-memory`, bypassing Kippu, with every
   * command the M1 rules did not accept (until now tested on hand-built records,
   * `F-025` plan §7a): capacity lowered and raised with a proof,
   * a restriction removed, a pass recorded, a ticket transferred, and the event
   * sealed. Each is judged by the ledger's own rules.
   */
  async function history() {
    const { direct, organiser, backend } = ledger;
    await ledger.registerOrganiser();
    const alice = await ledger.registerHolder(0x21);
    const bob = await ledger.registerHolder(0x22);
    const zone = zoneId(0x51);
    const concert = await ledger.createEvent(0x01, [zone], 10);

    const issue = async (
      discriminator: number,
      provenance: "Purchased" | "Granted",
      cannotTransfer: boolean,
    ) => {
      const issued = direct.issueTicket(organiser.signer, {
        event: concert,
        zone,
        placement: { kind: "Unseated", discriminator: hex(16, discriminator) as Discriminator },
        class: classId(provenance === "Purchased" ? 0xc1 : 0xc2) as ClassId,
        provenance,
        policy:
          provenance === "Purchased" ? { kind: "Single" } : { kind: "Unlimited", until: null },
        restrictions: { cannotResale: cannotTransfer, cannotTransfer },
        holder: alice.account,
        metadata: null,
      });
      await settled(issued.submission);
      return issued.id;
    };
    const seat = await issue(1, "Purchased", false);
    const press = await issue(2, "Granted", true);

    await settled(
      direct.setEventCapacity(organiser.signer, { event: concert, capacity: 8, proof: null }),
    );
    await settled(
      direct.setEventCapacity(organiser.signer, {
        event: concert,
        capacity: 12,
        proof: hex(16, 0x9f) as ProofId,
      }),
    );
    await settled(
      direct.removeRestriction(organiser.signer, {
        event: concert,
        ticket: press,
        restriction: "cannotTransfer",
      }),
    );

    // Alice's pass for her seat, presented and recorded now by the ledger's clock.
    const pass = await producePass(
      { ticket: seat, holder: alice.account, notBefore: backend.clock.now() },
      alice,
    );
    await settled(direct.submitAccessPass(pass, { presentedAt: backend.clock.now() }));

    const transferred = await settled(
      direct.transferTicket(alice, { event: concert, ticket: seat, receiver: bob.account }),
    );
    await settled(direct.setEventStatus(organiser.signer, { event: concert, status: "Sealed" }));

    return { concert, seat, press, pass, alice, bob, transferred };
  }

  it("NFR-11: after status, capacity, restriction removal, attendance and transfer, each projection equals the ledger's point queries", async () => {
    const { concert, seat, press, pass, alice, bob } = await history();
    const records = await wholeLog(ledger.kippu.log);
    expect(await reader().catchUp()).toBe(records.length);
    const queries = createDerivedQueries(database.store);

    const event = await ledger.kippu.getEvent(concert);
    if (!event.ok) throw new Error(event.error.code);
    expect(event.value).toMatchObject({ status: "Sealed", maxCapacity: 12, issued: 2 });
    expect((await queries.event(concert)).result?.value).toEqual(event.value);

    for (const id of [seat, press]) {
      const ticket = await ledger.kippu.getTicket(id);
      if (!ticket.ok) throw new Error(ticket.error.code);
      expect((await queries.ticket(id)).result?.value).toEqual(ticket.value);
    }
    const seatOnLedger = await ledger.kippu.getTicket(seat);
    const pressOnLedger = await ledger.kippu.getTicket(press);
    expect(seatOnLedger).toMatchObject({
      ok: true,
      value: { holder: bob.account, attendances: 1 },
    });
    expect(pressOnLedger).toMatchObject({
      ok: true,
      value: { restrictions: { cannotResale: true, cannotTransfer: false } },
    });

    // Attendance, and the consumed pass with the ledger's recording time.
    const passRecord = records.find((record) => "pass" in record.entry);
    expect((await queries.attendance(seat)).result?.value).toEqual({
      event: concert,
      ticket: seat,
      count: 1,
      lastRecordedAt: passRecord?.recordedAt,
    });
    expect((await queries.consumedPass(seat, pass.pass.id as PassId)).result?.value).toEqual({
      event: concert,
      ticket: seat,
      pass: pass.pass.id,
      holder: alice.account,
      notBefore: pass.pass.notBefore,
      notAfter: pass.pass.notAfter,
      presentedAt: passRecord?.presentedAt,
      recordedAt: passRecord?.recordedAt,
    });

    // Holdings follow the transfer, and the transfer history names both holders.
    expect((await queries.holdings(alice.account)).result.map((held) => held.value.id)).toEqual([
      press,
    ]);
    expect(
      (await queries.holdings(bob.account as AccountId)).result.map((h) => h.value.id),
    ).toEqual([seat]);
    const transferRecord = records.find(
      (record) => "command" in record.entry && record.entry.command.kind === "transferTicket",
    );
    expect((await queries.transfers(seat as TicketId, 0, Number.MAX_SAFE_INTEGER)).result).toEqual([
      {
        value: {
          event: concert as EventId,
          ticket: seat,
          from: alice.account,
          to: bob.account,
          recordedAt: transferRecord?.recordedAt,
        },
        sequence: records.indexOf(transferRecord as (typeof records)[number]),
        authoritative: false,
      },
    ]);
  });

  it("NFR-11: rebuilding that real log from cursor zero, in any batch size, yields identical projections", async () => {
    await history();
    const other = await createMigratedTestDatabase();
    try {
      await reader(1).catchUp();
      await createDerivedReader({
        store: other.store,
        log: ledger.kippu.log,
        projections: [ledgerFactsProjection(ledger.kippu)],
        batchSize: 100,
        onError: () => {},
      }).catchUp();
      expect(await derivedSnapshot(other.store)).toEqual(await derivedSnapshot(database.store));
    } finally {
      await other.drop();
    }
  });
});
