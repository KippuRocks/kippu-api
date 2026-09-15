import { afterAll, beforeAll, expect, it } from "vitest";
import type { DefineClassInput } from "../../src/events/ports.js";
import { describeWithStore } from "../support/database.js";
import { type EventsHarness, eventsHarness, randomId, refusal } from "../support/events.js";

const press = (event: string): DefineClassInput => ({
  event,
  name: "Press",
  description: "Accredited media",
  provenance: "Granted",
  policy: { kind: "Single" },
  restrictions: { cannotResale: true, cannotTransfer: true },
  quota: 20,
});

describeWithStore("ticket classes", () => {
  let harness: EventsHarness;

  beforeAll(async () => {
    harness = await eventsHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  const classCount = async (event: string) =>
    Number(
      (
        await harness.database.store.query<{ count: string }>(
          "SELECT count(*) FROM ticket_classes WHERE event = $1",
          [event],
        )
      ).rows[0]?.count,
    );

  it("AC-B2.1: an organiser defines several classes for an event, each with its own name, quota, policy and restrictions", async () => {
    const organiser = await harness.organiser();
    const event = await harness.createEventDirectly(organiser);

    const pressPass = await organiser.client.events.classes.define.mutate(press(event));
    const staff = await organiser.client.events.classes.define.mutate({
      event,
      name: "Staff",
      description: null,
      provenance: "Granted",
      policy: { kind: "Unlimited", until: 1_900_000_000_000 },
      restrictions: { cannotResale: true, cannotTransfer: false },
      quota: null,
    });
    const general = await organiser.client.events.classes.define.mutate({
      event,
      name: "General admission",
      description: null,
      provenance: "Purchased",
      price: 150_000,
      policy: { kind: "Multiple", max: 3, until: null },
      restrictions: { cannotResale: false, cannotTransfer: false },
      quota: 500,
    });

    expect(pressPass).toMatchObject({
      event,
      name: "Press",
      description: "Accredited media",
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: true, cannotTransfer: true },
      quota: 20,
    });
    expect(staff).toMatchObject({
      policy: { kind: "Unlimited", until: 1_900_000_000_000 },
      restrictions: { cannotResale: true, cannotTransfer: false },
      quota: null,
    });
    expect(general).toMatchObject({
      provenance: "Purchased",
      policy: { kind: "Multiple", max: 3, until: null },
      restrictions: { cannotResale: false, cannotTransfer: false },
      quota: 500,
    });

    // REQ-TC-2: each class has an opaque, random 32-byte identifier.
    const ids = [pressPass.id, staff.id, general.id];
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(ids).size).toBe(3);

    // REQ-TC-1: no single guest list — every class is listed, as defined.
    expect(await organiser.client.events.classes.list.query({ event })).toEqual([
      pressPass,
      staff,
      general,
    ]);
  });

  it("REQ-TC-3: a class declared Purchased with a restriction is refused at definition", async () => {
    const organiser = await harness.organiser();
    const event = await harness.createEventDirectly(organiser);

    for (const restrictions of [
      { cannotResale: true, cannotTransfer: false },
      { cannotResale: false, cannotTransfer: true },
      { cannotResale: true, cannotTransfer: true },
    ]) {
      expect(
        await refusal(() =>
          organiser.client.events.classes.define.mutate({
            ...press(event),
            provenance: "Purchased",
            restrictions,
          }),
        ),
      ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-RestrictionNotPermitted" });
    }
    expect(await classCount(event)).toBe(0);
  });

  it("REQ-TC-3: the store refuses a restricted Purchased class, whatever wrote it", async () => {
    const organiser = await harness.organiser();
    await expect(
      harness.database.store.query(
        `INSERT INTO ticket_classes (id, event, organiser_id, name, provenance, policy,
           cannot_resale, cannot_transfer, created_request_id, created_at, price)
         VALUES ($1, $2, $3, 'Scalpable', 'Purchased', '{"kind":"Single"}', true, false, 'r', now(), 100)`,
        [randomId(), randomId(), organiser.organiserId],
      ),
    ).rejects.toThrow(/ticket_classes_purchased_unrestricted/);
  });

  it("REQ-TK-2: a class whose tickets cannot be transferred cannot be resold either", async () => {
    const organiser = await harness.organiser();
    const event = await harness.createEventDirectly(organiser);

    const defined = await organiser.client.events.classes.define.mutate({
      ...press(event),
      restrictions: { cannotResale: false, cannotTransfer: true },
    });

    expect(defined.restrictions).toEqual({ cannotResale: true, cannotTransfer: true });
  });

  it("ERR-NotOwner: only the event's organiser defines or lists its classes", async () => {
    const owner = await harness.organiser();
    const other = await harness.organiser();
    const event = await harness.createEventDirectly(owner);
    await owner.client.events.classes.define.mutate(press(event));
    // An organiser with a ledger account of their own is still not the owner.
    await harness.createEventDirectly(other);

    const notOwner = { code: "FORBIDDEN", errorCode: "ERR-NotOwner" };
    expect(await refusal(() => other.client.events.classes.define.mutate(press(event)))).toEqual(
      notOwner,
    );
    expect(await refusal(() => other.client.events.classes.list.query({ event }))).toEqual(
      notOwner,
    );
    // An organiser with no ledger account at all.
    const fresh = await harness.organiser();
    expect(await refusal(() => fresh.client.events.classes.list.query({ event }))).toEqual(
      notOwner,
    );
    expect(await classCount(event)).toBe(1);
  });

  it("ERR-EventNotFound: a class is defined only for an event on the ledger", async () => {
    const organiser = await harness.organiser();
    const event = randomId();

    expect(
      await refusal(() => organiser.client.events.classes.define.mutate(press(event))),
    ).toEqual({
      code: "NOT_FOUND",
      errorCode: "ERR-EventNotFound",
    });
    expect(await classCount(event)).toBe(0);
  });

  it("refuses malformed definitions before anything is stored", async () => {
    const organiser = await harness.organiser();
    const event = await harness.createEventDirectly(organiser);

    for (const input of [
      { ...press(event), event: "not-an-event" },
      { ...press(event), name: "" },
      { ...press(event), quota: -1 },
      { ...press(event), policy: { kind: "Multiple", max: 2 } },
      { ...press(event), provenance: "Complimentary" },
      { ...press(event), organiserEmail: "someone@example.test" },
    ]) {
      expect(
        await refusal(() => organiser.client.events.classes.define.mutate(input as never)),
      ).toEqual({ code: "BAD_REQUEST", errorCode: null });
    }
    expect(await classCount(event)).toBe(0);
  });
});
