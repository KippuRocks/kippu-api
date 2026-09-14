import type { ClassId, Discriminator, EventId, ZoneId } from "@ticketto/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RefusedRequest } from "../../src/authority/errors.js";
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

describe("positionOf", () => {
  it("is the designation's UTF-8 bytes, as hex", () => {
    expect(positionOf("C-14")).toBe("432d3134");
    expect(positionOf("Palco Ñ")).toBe(Buffer.from("Palco Ñ", "utf8").toString("hex"));
  });

  it("refuses a designation that is not well-formed Unicode", () => {
    expect(() => positionOf("\ud800")).toThrow(TypeError);
  });
});

describeWithStore("zones and seat positions", () => {
  let harness: EventsHarness;

  beforeAll(async () => {
    harness = await eventsHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  const zonesOf = async (event: string) => {
    const found = await harness.ledger.getEvent(event as EventId);
    if (!found.ok) throw new Error(found.error.code);
    return found.value.zones;
  };

  async function eventWithSeatedZone(organiser: TestOrganiser) {
    const seated = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: seated, kind: "Seated" }],
      capacity: null,
    });
    return { event, seated };
  }

  it("REQ-ID-7: an organiser adds a zone of either kind to an Active event", async () => {
    const organiser = await harness.organiser();
    const { event, seated } = await eventWithSeatedZone(organiser);
    const unseated = randomId();

    const { cursor } = await organiser.client.events.zones.add.mutate({
      event,
      zone: { id: unseated, kind: "Unseated" },
    });

    expect(cursor).toEqual(expect.any(String));
    expect(await zonesOf(event)).toEqual([
      { id: seated, kind: "Seated" },
      { id: unseated, kind: "Unseated" },
    ]);
    const operations = await harness.database.store.query<{ operation_id: string }>(
      "SELECT operation_id FROM audit_log WHERE organiser_id = $1 AND command_kind = 'addZone'",
      [organiser.organiserId],
    );
    await expectEveryRelayedWriteAudited(
      harness.audit,
      operations.rows.map((row) => row.operation_id as never),
    );
  });

  it("ERR-ZoneExists: the ledger refuses a zone id the event already has", async () => {
    const organiser = await harness.organiser();
    const { event, seated } = await eventWithSeatedZone(organiser);

    expect(
      await refusal(() =>
        organiser.client.events.zones.add.mutate({ event, zone: { id: seated, kind: "Unseated" } }),
      ),
    ).toEqual({ code: "CONFLICT", errorCode: "ERR-ZoneExists" });
  });

  it("REQ-ID-7: an organiser removes a zone no ticket was issued in, and its positions go with it", async () => {
    const organiser = await harness.organiser();
    const { event, seated } = await eventWithSeatedZone(organiser);
    await organiser.client.events.zones.addSeatPositions.mutate({
      event,
      zone: seated,
      positions: ["A-1", "A-2"],
    });

    await organiser.client.events.zones.remove.mutate({ event, zone: seated });

    expect(await zonesOf(event)).toEqual([]);
    // Added again under the same id, the zone starts with no canonical positions.
    await organiser.client.events.zones.add.mutate({ event, zone: { id: seated, kind: "Seated" } });
    expect(
      await organiser.client.events.zones.seatPositions.query({ event, zone: seated }),
    ).toEqual({ event, zone: seated, positions: [] });
  });

  it("ERR-ZoneInUse: the ledger refuses to remove a zone a ticket was issued in", async () => {
    const organiser = await harness.organiser();
    const unseated = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: unseated, kind: "Unseated" }],
      capacity: null,
    });
    const account = await harness.authority.account(organiser.organiserId);
    const issued = await harness.authority.relay(organiser.organiserId, organiser.request, (s) =>
      harness.ledger.issueTicket(s, {
        event: event as EventId,
        zone: unseated as ZoneId,
        placement: { kind: "Unseated", discriminator: "7c".repeat(16) as Discriminator },
        class: "8d".repeat(32) as ClassId,
        provenance: "Granted",
        policy: { kind: "Single" },
        restrictions: { cannotResale: false, cannotTransfer: false },
        holder: account as never,
        metadata: null,
      }),
    );
    expect(await issued.submission).toMatchObject({ ok: true });

    expect(
      await refusal(() => organiser.client.events.zones.remove.mutate({ event, zone: unseated })),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-ZoneInUse" });
    expect(await zonesOf(event)).toEqual([{ id: unseated, kind: "Unseated" }]);
  });

  it("REQ-ID-3: a seated zone's canonical positions are uploaded, kept once each, and listed in upload order", async () => {
    const organiser = await harness.organiser();
    const { event, seated } = await eventWithSeatedZone(organiser);

    const first = await organiser.client.events.zones.addSeatPositions.mutate({
      event,
      zone: seated,
      positions: ["C-14", "C-15", "C-14"],
    });
    const second = await organiser.client.events.zones.addSeatPositions.mutate({
      event,
      zone: seated,
      positions: ["C-15", "C-16"],
    });

    expect(first.positions).toEqual(["C-14", "C-15"]);
    expect(second).toEqual({ event, zone: seated, positions: ["C-14", "C-15", "C-16"] });
    expect(
      await organiser.client.events.zones.seatPositions.query({ event, zone: seated }),
    ).toEqual(second);
  });

  it("ERR-ZoneKindMismatch and ERR-UnknownZone: only a seated zone of the event has seat positions", async () => {
    const organiser = await harness.organiser();
    const unseated = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: unseated, kind: "Unseated" }],
      capacity: null,
    });

    expect(
      await refusal(() =>
        organiser.client.events.zones.addSeatPositions.mutate({
          event,
          zone: unseated,
          positions: ["A-1"],
        }),
      ),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-ZoneKindMismatch" });
    expect(
      await refusal(() =>
        organiser.client.events.zones.addSeatPositions.mutate({
          event,
          zone: randomId(),
          positions: ["A-1"],
        }),
      ),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-UnknownZone" });
  });

  it("REQ-ID-3: a non-canonical position is refused before submission", async () => {
    const organiser = await harness.organiser();
    const { event, seated } = await eventWithSeatedZone(organiser);
    const other = await eventWithSeatedZone(organiser);
    await organiser.client.events.zones.addSeatPositions.mutate({
      event,
      zone: seated,
      positions: ["C-14"],
    });
    const sponsoredBefore = harness.sponsored.length;
    const auditedBefore = await harness.database.store.query("SELECT 1 FROM audit_log");

    await expect(harness.events.zones.canonicalPosition(event, seated, "C-14")).resolves.toBe(
      positionOf("C-14"),
    );
    for (const [inEvent, zone, designation] of [
      [event, seated, "c14"],
      [event, seated, "C14"],
      [event, seated, "c-14"],
      [event, seated, " C-14"],
      [event, seated, "C-99"],
      [other.event, other.seated, "C-14"],
    ] as const) {
      await expect(
        harness.events.zones.canonicalPosition(inEvent, zone, designation),
      ).rejects.toThrow(RefusedRequest);
    }

    // Nothing was signed, sponsored or submitted.
    expect(harness.sponsored.length).toBe(sponsoredBefore);
    expect((await harness.database.store.query("SELECT 1 FROM audit_log")).rowCount).toBe(
      auditedBefore.rowCount,
    );
  });

  it("ERR-NotOwner: another organiser cannot change an event's zones or read its positions", async () => {
    const owner = await harness.organiser();
    const other = await harness.organiser();
    const { event, seated } = await eventWithSeatedZone(owner);
    const notOwner = { code: "FORBIDDEN", errorCode: "ERR-NotOwner" };

    expect(
      await refusal(() =>
        other.client.events.zones.add.mutate({ event, zone: { id: randomId(), kind: "Seated" } }),
      ),
    ).toEqual(notOwner);
    expect(
      await refusal(() => other.client.events.zones.remove.mutate({ event, zone: seated })),
    ).toEqual(notOwner);
    expect(
      await refusal(() =>
        other.client.events.zones.addSeatPositions.mutate({
          event,
          zone: seated,
          positions: ["A-1"],
        }),
      ),
    ).toEqual(notOwner);
    expect(
      await refusal(() => other.client.events.zones.seatPositions.query({ event, zone: seated })),
    ).toEqual(notOwner);
    expect(await zonesOf(event)).toEqual([{ id: seated, kind: "Seated" }]);
  });

  it("refuses malformed seat positions before anything is stored", async () => {
    const organiser = await harness.organiser();
    const { event, seated } = await eventWithSeatedZone(organiser);

    for (const positions of [[], [""], ["x".repeat(101)], ["\ud800"], [14]]) {
      expect(
        await refusal(() =>
          organiser.client.events.zones.addSeatPositions.mutate({
            event,
            zone: seated,
            positions: positions as never,
          }),
        ),
      ).toEqual({ code: "BAD_REQUEST", errorCode: null });
    }
    expect(
      await organiser.client.events.zones.seatPositions.query({ event, zone: seated }),
    ).toEqual({ event, zone: seated, positions: [] });
  });
});
