import { softwareP256Signer } from "@ticketto/profile-v0/testing";
import type {
  ClassId,
  Discriminator,
  EventId,
  OperationId,
  Placement,
  ZoneId,
} from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeWithStore } from "../support/database.js";
import { type EventsHarness, eventsHarness, randomId, refusal } from "../support/events.js";
import { expectEveryRelayedWriteAudited } from "../support/ledger.js";

// Store-backed: generous timeouts, so a loaded CI host or database does not fail the suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describeWithStore("creating an event", () => {
  let harness: EventsHarness;

  beforeAll(async () => {
    harness = await eventsHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  const operationsOf = async (organiserId: string): Promise<OperationId[]> =>
    (
      await harness.database.store.query<{ operation_id: OperationId }>(
        "SELECT operation_id FROM audit_log WHERE organiser_id = $1 ORDER BY id",
        [organiserId],
      )
    ).rows.map((row) => row.operation_id);

  it("AC-A1.1: an organiser creates an event, and the ledger records it Active, owned by them", async () => {
    const organiser = await harness.organiser();
    const seated = randomId();
    const unseated = randomId();

    const { event, cursor } = await organiser.client.events.create.mutate({
      zones: [
        { id: seated, kind: "Seated" },
        { id: unseated, kind: "Unseated" },
      ],
      capacity: 250,
    });

    expect(event).toMatch(/^[0-9a-f]{64}$/);
    expect(cursor).toEqual(expect.any(String));
    const account = await harness.authority.account(organiser.organiserId);
    expect(account).not.toBeNull();
    expect(await harness.ledger.getEvent(event as EventId)).toEqual({
      ok: true,
      value: {
        id: event,
        owner: account,
        status: "Active",
        maxCapacity: 250,
        issued: 0,
        zones: [
          { id: seated, kind: "Seated" },
          { id: unseated, kind: "Unseated" },
        ],
      },
    });

    // The event is linked to the organiser in Kippu's store, with the creation's cursor.
    const link = await harness.database.store.query(
      "SELECT organiser_id, receipt_cursor FROM organiser_events WHERE event = $1",
      [event],
    );
    expect(link.rows).toEqual([{ organiser_id: organiser.organiserId, receipt_cursor: cursor }]);

    // NFR-7 and REQ-SP-1: the account's registration and the creation are audited and sponsored.
    const operations = await operationsOf(organiser.organiserId);
    expect(operations).toHaveLength(2);
    await expectEveryRelayedWriteAudited(harness.audit, operations);
    expect(harness.sponsored).toEqual(expect.arrayContaining(operations));
  });

  it("AC-A1.2: an event created with no capacity leaves issuance unbounded", async () => {
    const organiser = await harness.organiser();

    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: randomId(), kind: "Unseated" }],
      capacity: null,
    });

    expect(await harness.ledger.getEvent(event as EventId)).toMatchObject({
      ok: true,
      value: { maxCapacity: null, status: "Active" },
    });
  });

  it("REQ-EV-9: each creation derives a distinct event id, through the profile, from the organiser's account", async () => {
    const organiser = await harness.organiser();
    const input = { zones: [], capacity: null };

    const first = await organiser.client.events.create.mutate(input);
    const second = await organiser.client.events.create.mutate(input);

    expect(first.event).not.toBe(second.event);
    const account = await harness.authority.account(organiser.organiserId);
    for (const { event } of [first, second]) {
      expect(await harness.ledger.getEvent(event as EventId)).toMatchObject({
        ok: true,
        value: { owner: account },
      });
    }
  });

  it("ERR-ZoneExists: the ledger's refusal of a zone id named twice reaches the organiser, and nothing is linked", async () => {
    const organiser = await harness.organiser();
    const zone = randomId();

    expect(
      await refusal(() =>
        organiser.client.events.create.mutate({
          zones: [
            { id: zone, kind: "Seated" },
            { id: zone, kind: "Unseated" },
          ],
          capacity: null,
        }),
      ),
    ).toEqual({ code: "CONFLICT", errorCode: "ERR-ZoneExists" });

    const links = await harness.database.store.query(
      "SELECT 1 FROM organiser_events WHERE organiser_id = $1",
      [organiser.organiserId],
    );
    expect(links.rowCount).toBe(0);
    const [, creation] = await operationsOf(organiser.organiserId);
    expect(await harness.audit.find(creation as OperationId)).toMatchObject({
      commandKind: "createEvent",
      outcome: "rejected",
      errorCode: "ERR-ZoneExists",
    });
  });

  it("AC-A2.1: the sponsor, a ledger account of Kippu's own, has no authority over the event", async () => {
    const organiser = await harness.organiser();
    const zone = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: zone, kind: "Unseated" }],
      capacity: null,
    });
    const sponsorKey = softwareP256Signer();
    const registered = await harness.ledger.registerCredential(sponsorKey.signer, {
      account: sponsorKey.signer.account,
      registration: sponsorKey.registration,
    });
    expect(registered.ok).toBe(true);

    // REQ-SP-2: it relays and pays; it can neither administer the event nor issue against it.
    const addZone = await harness.ledger.addZone(sponsorKey.signer, {
      event: event as EventId,
      zone: { id: randomId(), kind: "Seated" },
    });
    expect(addZone).toMatchObject({ ok: false, error: { code: "ERR-NotOwner" } });
    const placement: Placement = {
      kind: "Unseated",
      discriminator: "5a".repeat(16) as Discriminator,
    };
    const issued = harness.ledger.issueTicket(sponsorKey.signer, {
      event: event as EventId,
      zone: zone as ZoneId,
      placement,
      class: "6b".repeat(32) as ClassId,
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: false, cannotTransfer: false },
      holder: sponsorKey.signer.account,
      metadata: null,
    });
    expect(await issued.submission).toMatchObject({ ok: false, error: { code: "ERR-NotOwner" } });
  });

  it("refuses malformed input before anything reaches the ledger", async () => {
    const organiser = await harness.organiser();
    const before = harness.sponsored.length;

    for (const input of [
      { zones: [{ id: "zone-a", kind: "Seated" }], capacity: null },
      { zones: [{ id: randomId(), kind: "Standing" }], capacity: null },
      { zones: [], capacity: -1 },
      { zones: [], capacity: 1.5 },
      { zones: [{ id: randomId(), kind: "Seated", name: "Stalls" }], capacity: null },
      { zones: [], capacity: null, venueContactEmail: "someone@example.test" },
    ]) {
      expect(await refusal(() => organiser.client.events.create.mutate(input as never))).toEqual({
        code: "BAD_REQUEST",
        errorCode: null,
      });
    }
    expect(harness.sponsored.length).toBe(before);
  });
});
