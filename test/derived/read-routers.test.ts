import { randomBytes } from "node:crypto";
import { classLocator, eventLocator } from "@kippu/metadata-schema";
import type { AccountId, ClassId, Discriminator, EventId, TicketId, ZoneId } from "@ticketto/sdk";
import type { TRPCError } from "@trpc/server";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ANONYMOUS, type Principal, type Services } from "../../src/auth/ports.js";
import { createFreshness, type Freshness } from "../../src/derived/freshness.js";
import { ledgerFactsProjection } from "../../src/derived/ledger-facts.js";
import { createDerivedReader, type DerivedReader } from "../../src/derived/reader.js";
import { createReads } from "../../src/derived/reads.js";
import type { MetadataStorage } from "../../src/metadata/storage.js";
import type { Context } from "../../src/trpc/context.js";
import { appRouter } from "../../src/trpc/router.js";
import { createCallerFactory } from "../../src/trpc/trpc.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  type TestOrganiser,
} from "../support/events.js";
import { memoryMetadataStorage } from "../support/object-storage.js";

// These tests create databases and write to a ledger: on a loaded machine that
// takes far longer than Vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describeWithStore("read routers for Saifu, Ibento and Ichiba", () => {
  let harness: EventsHarness;
  let storage: MetadataStorage & { readonly reads: string[] };
  let freshness: Freshness;
  let reader: DerivedReader;
  let services: Services;

  beforeAll(async () => {
    const memory = memoryMetadataStorage();
    // Documents are written through the organiser editing routers (F-026), into this storage.
    harness = await eventsHarness({ metadataStorage: memory });
    const reads: string[] = [];
    storage = {
      ...memory,
      reads,
      get: (key) => {
        reads.push(key);
        return memory.get(key);
      },
    };
    const store = harness.database.store;
    freshness = createFreshness({ store, pollInterval: 50 });
    reader = createDerivedReader({
      store,
      log: harness.ledger.log,
      projections: [ledgerFactsProjection(harness.ledger)],
      pollInterval: 50,
      onError: () => {},
    });
    services = {
      ...({} as Services),
      derived: createReads({ store, freshness, storage, authority: harness.authority }),
    };
  });

  afterEach(async () => {
    await reader.stop();
  });

  afterAll(async () => {
    await freshness.close();
    await harness.close();
  });

  const as = (principal: Principal) => {
    const context: Context = {
      requestId: "test",
      session:
        principal.kind === "anonymous"
          ? null
          : { principal, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      principal,
      services,
    };
    return createCallerFactory(appRouter)(context);
  };

  const organiserPrincipal = (organiser: TestOrganiser): Principal => {
    if (organiser.request.principal.kind !== "organiser") throw new Error("expected an organiser");
    return organiser.request.principal;
  };

  async function createEvent(organiser: TestOrganiser) {
    const zone = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: zone, kind: "Unseated" }],
      capacity: 100,
    });
    return { event, zone };
  }

  const eventDocument = (event: string) => ({
    $schema: "https://meta.kippu.rocks/v0/schemas/event/1.0.json",
    eventId: event,
    name: "Autumn Night Concert",
    description: "An evening of chamber music.",
  });

  it("AC-A3.2: an event is returned as one object of ledger facts and metadata", async () => {
    const organiser = await harness.organiser();
    const { event, zone } = await createEvent(organiser);
    const document = eventDocument(event);
    await organiser.client.metadata.events.put.mutate({ event, document });
    await reader.catchUp();

    // Anonymous, as Ichiba's event pages are (REQ-MP-7).
    const read = await as(ANONYMOUS).derived.events.get({ event });

    const onLedger = await harness.ledger.getEvent(event as EventId);
    if (!onLedger.ok) throw new Error(onLedger.error.code);
    expect(read.event).toEqual({
      ...onLedger.value,
      zones: [{ id: zone, kind: "Unseated" }],
      metadataLocator: eventLocator(event),
      metadata: document,
      sequence: expect.any(Number),
      authoritative: false,
    });
    expect(read.freshness).toEqual(
      expect.objectContaining({ cursor: expect.any(String), records: expect.any(Number) }),
    );
  });

  it("REQ-MD-2: an event with no document is still returned, from its ledger facts", async () => {
    const organiser = await harness.organiser();
    const { event } = await createEvent(organiser);
    await reader.catchUp();
    const read = await as(ANONYMOUS).derived.events.get({ event });
    expect(read.event).toMatchObject({
      id: event,
      status: "Active",
      maxCapacity: 100,
      metadataLocator: eventLocator(event),
      metadata: null,
    });

    const unknown = await as(ANONYMOUS).derived.events.get({ event: randomId() });
    expect(unknown).toEqual({ event: null, freshness: read.freshness });
  });

  it("never fetches a locator outside Kippu's metadata origin", async () => {
    const organiser = await harness.organiser();
    const elsewhere = "https://elsewhere.example/v0/events/document.json";
    const event = await harness.authority.relay(
      organiser.organiserId,
      organiser.request,
      (signer) =>
        harness.ledger.createEvent(signer, {
          salt: randomBytes(32),
          zones: [],
          capacity: null,
          metadata: elsewhere,
        }),
    );
    expect(await event.submission).toMatchObject({ ok: true });
    await reader.catchUp();
    const before = storage.reads.length;

    const read = await as(ANONYMOUS).derived.events.get({ event: event.id });
    expect(read.event).toMatchObject({ metadataLocator: elsewhere, metadata: null });
    expect(storage.reads.length).toBe(before);
  });

  it("Ibento: an organiser lists the events they own, newest first, and no one else's", async () => {
    const organiser = await harness.organiser();
    const other = await harness.organiser();
    const first = await createEvent(organiser);
    const second = await createEvent(organiser);
    await createEvent(other);
    await organiser.client.metadata.events.put.mutate({
      event: second.event,
      document: eventDocument(second.event),
    });
    await reader.catchUp();

    const read = await as(organiserPrincipal(organiser)).derived.events.mine();
    expect(read.events.map((event) => event.id)).toEqual([second.event, first.event]);
    expect(read.events.map((event) => event.metadata)).toEqual([eventDocument(second.event), null]);

    const stranger = await harness.organiser();
    expect((await as(organiserPrincipal(stranger)).derived.events.mine()).events).toEqual([]);
  });

  it("Saifu: a holder's holdings come with each ticket's class metadata and its event, fresh after waitFor", async () => {
    const organiser = await harness.organiser();
    const { event, zone } = await createEvent(organiser);
    await organiser.client.metadata.events.put.mutate({ event, document: eventDocument(event) });
    const press = await organiser.client.events.classes.define.mutate({
      event,
      name: "Press",
      description: null,
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: true, cannotTransfer: true },
      quota: null,
    });
    const pressDocument = {
      $schema: "https://meta.kippu.rocks/v0/schemas/class/1.0.json",
      classId: press.id,
      eventId: event,
      name: "Press",
    };
    await organiser.client.metadata.classes.put.mutate({
      event,
      class: press.id,
      document: pressDocument,
    });

    reader.start();
    const account = randomBytes(32).toString("hex");
    const holder: Principal = { kind: "holder", account, sessionId: "test" };
    const { ticket, cursor } = await organiser.client.events.tickets.issueGranted.mutate({
      event,
      class: press.id,
      zone,
      placement: { kind: "Unseated" },
      holder: account,
    });

    const waited = await as(holder).derived.waitFor({ cursor, timeout: 10_000 });
    expect(waited.reached).toBe(true);

    const read = await as(holder).derived.holdings.mine();
    const onLedger = await harness.ledger.getTicket(ticket as TicketId);
    if (!onLedger.ok) throw new Error(onLedger.error.code);
    expect(read.holdings).toHaveLength(1);
    expect(read.holdings[0]).toEqual({
      ticket: {
        ...onLedger.value,
        // AC-B2.6: a press pass is legible as one through Kippu.
        kippuClass: { name: "Press" },
        classMetadataLocator: classLocator(press.id),
        classMetadata: pressDocument,
        sequence: expect.any(Number),
        authoritative: false,
      },
      event: expect.objectContaining({ id: event, metadata: eventDocument(event) }),
    });
    expect(read.freshness.records).toBeGreaterThanOrEqual(waited.freshness.records);
  });

  it("AC-B2.6: a press pass is legible as one through Kippu before any class document is written", async () => {
    const organiser = await harness.organiser();
    const { event, zone } = await createEvent(organiser);
    const press = await organiser.client.events.classes.define.mutate({
      event,
      name: "Press",
      description: null,
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: true, cannotTransfer: true },
      quota: null,
    });
    const account = randomBytes(32).toString("hex");
    await organiser.client.events.tickets.issueGranted.mutate({
      event,
      class: press.id,
      zone,
      placement: { kind: "Unseated" },
      holder: account,
    });

    // A ticket of the same event, issued straight through the SDK under a class Kippu never defined.
    const undefinedClass = randomBytes(32).toString("hex") as ClassId;
    const direct = await harness.authority.relay(
      organiser.organiserId,
      organiser.request,
      (signer) =>
        harness.ledger.issueTicket(signer, {
          event: event as EventId,
          zone: zone as ZoneId,
          placement: {
            kind: "Unseated",
            discriminator: randomBytes(16).toString("hex") as Discriminator,
          },
          class: undefinedClass,
          provenance: "Granted",
          policy: { kind: "Single" },
          restrictions: { cannotResale: false, cannotTransfer: false },
          holder: account as AccountId,
          metadata: null,
        }),
    );
    expect(await direct.submission).toMatchObject({ ok: true });
    await reader.catchUp();

    const { holdings } = await as({
      kind: "holder",
      account,
      sessionId: "test",
    }).derived.holdings.mine();
    const byClass = new Map(holdings.map(({ ticket }) => [ticket.class, ticket]));
    expect(byClass.get(press.id)).toMatchObject({
      kippuClass: { name: "Press" },
      classMetadata: null,
      restrictions: { cannotResale: true, cannotTransfer: true },
    });
    expect(byClass.get(undefinedClass)).toMatchObject({ kippuClass: null, classMetadata: null });
  });

  it("each read is open only to whom it serves", async () => {
    const refused = async (call: () => Promise<unknown>) => {
      try {
        await call();
      } catch (error) {
        return (error as TRPCError).code;
      }
      return "OK";
    };
    const organiser = await harness.organiser();
    expect(await refused(() => as(ANONYMOUS).derived.events.mine())).toBe("UNAUTHORIZED");
    expect(await refused(() => as(ANONYMOUS).derived.holdings.mine())).toBe("UNAUTHORIZED");
    expect(await refused(() => as(ANONYMOUS).derived.waitFor({ cursor: "", timeout: 0 }))).toBe(
      "UNAUTHORIZED",
    );
    expect(await refused(() => as(organiserPrincipal(organiser)).derived.holdings.mine())).toBe(
      "FORBIDDEN",
    );
    expect(
      await refused(() =>
        as(organiserPrincipal(organiser)).derived.waitFor({ cursor: "", timeout: 60_000 }),
      ),
    ).toBe("BAD_REQUEST");
  });
});
