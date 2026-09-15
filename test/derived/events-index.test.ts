import { eventLocator } from "@kippu/metadata-schema";
import type { Authorisation, EventId, EventStatus, OperationId } from "@ticketto/sdk";
import type { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildApp, TRPC_PREFIX } from "../../src/app.js";
import { ANONYMOUS, type Services } from "../../src/auth/ports.js";
import { createFreshness, type Freshness } from "../../src/derived/freshness.js";
import { ledgerFactsProjection } from "../../src/derived/ledger-facts.js";
import type { EventsOnSalePage } from "../../src/derived/ports.js";
import { createDerivedReader } from "../../src/derived/reader.js";
import { createReads } from "../../src/derived/reads.js";
import type { DefineClassInput } from "../../src/events/ports.js";
import type { Context } from "../../src/trpc/context.js";
import { appRouter } from "../../src/trpc/router.js";
import { createCallerFactory } from "../../src/trpc/trpc.js";
import { describeWithStore } from "../support/database.js";
import { scriptedLog, wholeLog } from "../support/derived.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  type TestOrganiser,
} from "../support/events.js";
import { memoryMetadataStorage } from "../support/object-storage.js";

const hex = (length: number, byte: number) => byte.toString(16).padStart(2, "0").repeat(length);

describeWithStore("the public index of events on sale", () => {
  let harness: EventsHarness;
  let freshness: Freshness;
  let services: Services;

  beforeEach(async () => {
    const storage = memoryMetadataStorage();
    harness = await eventsHarness({ metadataStorage: storage });
    const store = harness.database.store;
    freshness = createFreshness({ store, pollInterval: 50 });
    services = {
      ...({} as Services),
      derived: createReads({ store, freshness, storage, authority: harness.authority }),
    };
  });

  afterEach(async () => {
    await freshness.close();
    await harness.close();
  });

  /** The index, as a visitor with no session reads it (`REQ-MP-7`). */
  const anonymous = () => {
    const context: Context = { requestId: "test", session: null, principal: ANONYMOUS, services };
    return createCallerFactory(appRouter)(context);
  };

  const catchUp = (log = harness.ledger.log) =>
    createDerivedReader({
      store: harness.database.store,
      log,
      projections: [ledgerFactsProjection(harness.ledger)],
      onError: () => {},
    }).catchUp();

  const classOf = (event: string, provenance: DefineClassInput["provenance"]) => ({
    event,
    name: provenance === "Purchased" ? "General admission" : "Guest list",
    description: null,
    provenance,
    policy: { kind: "Single" as const },
    restrictions: { cannotResale: false, cannotTransfer: false },
    quota: null,
  });

  async function eventWith(
    organiser: TestOrganiser,
    provenances: readonly DefineClassInput["provenance"][],
  ): Promise<string> {
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: randomId(), kind: "Unseated" }],
      capacity: null,
    });
    for (const provenance of provenances) {
      await organiser.client.events.classes.define.mutate(classOf(event, provenance));
    }
    return event;
  }

  const ids = (page: EventsOnSalePage) => page.events.map((event) => event.id);

  it("REQ-MP-7: Active events with a Purchased class are listed with no session, as get returns them", async () => {
    const organiser = await harness.organiser();
    const other = await harness.organiser();
    const onSale = await eventWith(organiser, ["Granted", "Purchased"]);
    const guestsOnly = await eventWith(organiser, ["Granted"]);
    const noClasses = await eventWith(other, []);
    const alsoOnSale = await eventWith(other, ["Purchased"]);
    const document = {
      $schema: "https://meta.kippu.rocks/v0/schemas/event/1.0.json",
      eventId: onSale,
      name: "Autumn Night Concert",
    };
    await organiser.client.metadata.events.put.mutate({ event: onSale, document });
    await catchUp();

    const page = await anonymous().derived.events.onSale();

    expect(ids(page)).toEqual([alsoOnSale, onSale]);
    expect(ids(page)).not.toContain(guestsOnly);
    expect(ids(page)).not.toContain(noClasses);
    expect(page.nextPage).toBeNull();
    // Each entry is what an event page reads: ledger facts, locator and document (AC-A3.2).
    const single = await anonymous().derived.events.get({ event: onSale });
    expect(page.events[1]).toEqual(single.event);
    expect(page.events[1]).toMatchObject({
      status: "Active",
      metadataLocator: eventLocator(onSale),
      metadata: document,
      authoritative: false,
    });
    expect(page.freshness).toEqual(single.freshness);

    // Over HTTP too, with no Authorization header and no cookie.
    const app = buildApp({}, appRouter, services);
    try {
      const response = await app.inject({
        method: "GET",
        url: `${TRPC_PREFIX}/derived.events.onSale`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(JSON.parse(response.body).result.data.events.map((e: { id: string }) => e.id)).toEqual(
        [alsoOnSale, onSale],
      );
    } finally {
      await app.close();
    }
  });

  it("pages through the index, newest first, with no event repeated or skipped", async () => {
    const organiser = await harness.organiser();
    const created: string[] = [];
    for (let n = 0; n < 5; n += 1) {
      created.push(await eventWith(organiser, ["Purchased"]));
    }
    await catchUp();

    const seen: string[] = [];
    let page: string | null = null;
    let pages = 0;
    do {
      const read: EventsOnSalePage = await anonymous().derived.events.onSale({ limit: 2, page });
      expect(read.events.length).toBeLessThanOrEqual(2);
      seen.push(...ids(read));
      page = read.nextPage;
      pages += 1;
    } while (page !== null);

    expect(seen).toEqual([...created].reverse());
    expect(pages).toBe(3);

    // An event created after the first page was read does not shift what follows.
    const first = await anonymous().derived.events.onSale({ limit: 2 });
    const newer = await eventWith(organiser, ["Purchased"]);
    await catchUp();
    const second = await anonymous().derived.events.onSale({ limit: 2, page: first.nextPage });
    expect(ids(second)).toEqual([created[2], created[1]]);
    expect(ids(await anonymous().derived.events.onSale({ limit: 1 }))).toEqual([newer]);
  });

  it("cancelled and finished events are not listed, nor sealed ones", async () => {
    // The M2 ledger rules do not accept setEventStatus yet (T-008-04), so the
    // status changes are appended, as hand-built records, to the real log (F-025 plan §7a).
    const organiser = await harness.organiser();
    const cancelled = await eventWith(organiser, ["Purchased"]);
    const finished = await eventWith(organiser, ["Purchased"]);
    const sealed = await eventWith(organiser, ["Purchased"]);
    const active = await eventWith(organiser, ["Purchased"]);

    const prefix = (await wholeLog(harness.ledger.log)).map(({ cursor: _, ...record }) => record);
    let recordedAt = (prefix.at(-1)?.recordedAt ?? 0) + 1;
    const status = (event: string, to: EventStatus, n: number) => ({
      recordedAt: recordedAt++,
      event: {
        id: event as EventId,
        sequence: prefix.filter((record) => record.event?.id === event).length,
      },
      entry: {
        command: {
          kind: "setEventStatus" as const,
          operationId: hex(16, n) as OperationId,
          expiresAt: 1_900_000_000_000,
          event: event as EventId,
          status: to,
        },
        authorisation: new Uint8Array(0) as Authorisation,
      },
      presentedAt: null,
    });
    const { log } = scriptedLog([
      ...prefix,
      status(cancelled, "Cancelled", 1),
      status(finished, "Finished", 2),
      status(sealed, "Sealed", 3),
    ]);
    await catchUp(log);

    const page = await anonymous().derived.events.onSale();
    expect(ids(page)).toEqual([active]);
    for (const [event, to] of [
      [cancelled, "Cancelled"],
      [finished, "Finished"],
      [sealed, "Sealed"],
    ] as const) {
      expect((await anonymous().derived.events.get({ event })).event?.status).toBe(to);
    }
  });

  it("refuses a page token it did not issue, and a page size out of range", async () => {
    const refused = async (call: () => Promise<unknown>) => {
      try {
        await call();
      } catch (error) {
        return (error as TRPCError).code;
      }
      return "OK";
    };
    for (const page of ["not-a-page", `1.${hex(32, 0xab).toUpperCase()}`, `01.${hex(32, 1)}`]) {
      expect(await refused(() => anonymous().derived.events.onSale({ page }))).toBe("BAD_REQUEST");
    }
    expect(await refused(() => anonymous().derived.events.onSale({ limit: 0 }))).toBe(
      "BAD_REQUEST",
    );
    expect(await refused(() => anonymous().derived.events.onSale({ limit: 101 }))).toBe(
      "BAD_REQUEST",
    );
    expect(await anonymous().derived.events.onSale({ page: `7.${hex(32, 1)}` })).toMatchObject({
      events: [],
      nextPage: null,
    });
  });
});
