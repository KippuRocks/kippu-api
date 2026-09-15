import type { Cursor, EventId, TicketId } from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { CreateInvitationInput, DefineClassInput } from "../../src/events/ports.js";
import { positionOf } from "../../src/events/zones.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  refusal,
  type TestOrganiser,
} from "../support/events.js";

// Store-backed: generous timeouts, so a loaded CI host or database does not fail the suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const granted = (event: string, overrides: Partial<DefineClassInput> = {}): DefineClassInput => ({
  event,
  name: "Artist guests",
  description: null,
  provenance: "Granted",
  policy: { kind: "Single" },
  restrictions: { cannotResale: true, cannotTransfer: false },
  quota: null,
  ...overrides,
});

describeWithStore("invitations", () => {
  let harness: EventsHarness;

  beforeAll(async () => {
    harness = await eventsHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  interface Setup {
    readonly organiser: TestOrganiser;
    readonly event: string;
    readonly seated: string;
    readonly unseated: string;
    readonly guests: string;
  }

  async function setup(classOverrides: Partial<DefineClassInput> = {}): Promise<Setup> {
    const organiser = await harness.organiser();
    const seated = randomId();
    const unseated = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [
        { id: seated, kind: "Seated" },
        { id: unseated, kind: "Unseated" },
      ],
      capacity: null,
    });
    const guests = await organiser.client.events.classes.define.mutate(
      granted(event, classOverrides),
    );
    return { organiser, event, seated, unseated, guests: guests.id };
  }

  const unseatedInvitation = (
    { event, unseated, guests }: Setup,
    guest: string | null = null,
  ): CreateInvitationInput => ({
    event,
    class: guests,
    zone: unseated,
    placement: { kind: "Unseated" },
    guest,
  });

  const ticketOnLedger = async (ticket: string) => {
    const found = await harness.ledger.getTicket(ticket as TicketId);
    if (!found.ok) throw new Error(found.error.code);
    return found.value;
  };

  it("REQ-TC-4: a holder session redeeming an invitation receives the class's ticket once", async () => {
    const context = await setup();
    const { invitation, token } = await context.organiser.client.events.invitations.create.mutate(
      unseatedInvitation(context, "Ada Lovelace"),
    );
    expect(invitation).toMatchObject({
      event: context.event,
      class: context.guests,
      guest: "Ada Lovelace",
      status: "open",
      holder: null,
      ticket: null,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const guest = harness.holder();

    const redeemed = await guest.client.events.invitations.redeem.mutate({ token });

    expect(redeemed).toMatchObject({ event: context.event, class: context.guests });
    expect(await ticketOnLedger(redeemed.ticket)).toMatchObject({
      event: context.event,
      holder: guest.account,
      class: context.guests,
      provenance: "Granted",
      restrictions: { cannotResale: true, cannotTransfer: false },
    });
    const [listed] = await context.organiser.client.events.invitations.list.query({
      event: context.event,
      class: null,
    });
    expect(listed).toMatchObject({
      id: invitation.id,
      status: "redeemed",
      holder: guest.account,
      ticket: redeemed.ticket,
      redeemedAt: expect.any(String),
    });

    // Once: the same holder, or anyone else, is refused a second redemption.
    const conflict = { code: "CONFLICT", errorCode: null };
    expect(await refusal(() => guest.client.events.invitations.redeem.mutate({ token }))).toEqual(
      conflict,
    );
    expect(
      await refusal(() => harness.holder().client.events.invitations.redeem.mutate({ token })),
    ).toEqual(conflict);
    expect(await harness.ledger.getEvent(context.event as EventId)).toMatchObject({
      ok: true,
      value: { issued: 1 },
    });

    // NFR-7: the issuance is attributed to the holder's request, signed with the organiser's authority.
    const audited = await harness.database.store.query(
      "SELECT principal_kind, holder_account, outcome FROM audit_log WHERE command_kind = 'issueTicket' AND holder_account = $1",
      [guest.account],
    );
    expect(audited.rows).toEqual([
      { principal_kind: "holder", holder_account: guest.account, outcome: "settled" },
    ]);
  });

  it("refuses an unknown token", async () => {
    const guest = harness.holder();

    expect(
      await refusal(() => guest.client.events.invitations.redeem.mutate({ token: "A".repeat(43) })),
    ).toEqual({ code: "NOT_FOUND", errorCode: null });
    expect(
      await refusal(() => guest.client.events.invitations.redeem.mutate({ token: "short" })),
    ).toEqual({ code: "BAD_REQUEST", errorCode: null });
  });

  it("issues once however many redemptions race", async () => {
    const context = await setup();
    const { token } = await context.organiser.client.events.invitations.create.mutate(
      unseatedInvitation(context),
    );

    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        harness.holder().client.events.invitations.redeem.mutate({ token }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await harness.ledger.getEvent(context.event as EventId)).toMatchObject({
      ok: true,
      value: { issued: 1 },
    });
  });

  it("NFR-6: the guest note stays in Kippu, and never reaches the ledger", async () => {
    const context = await setup();
    const note = "Grace Hopper <grace@example.test>";
    const { token } = await context.organiser.client.events.invitations.create.mutate(
      unseatedInvitation(context, note),
    );
    const guest = harness.holder();
    await guest.client.events.invitations.redeem.mutate({ token });

    // Every record the ledger's log holds, as bytes and as JSON, carries no trace of it.
    const records: unknown[] = [];
    let cursor = "" as Cursor;
    for (;;) {
      const page = await harness.ledger.log.read(cursor, 100);
      if (!page.ok) throw new Error(page.error.code);
      records.push(...page.value.records);
      if (page.value.records.length === 0 || page.value.next === cursor) break;
      cursor = page.value.next;
    }
    expect(records.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(records, (_, value) =>
      value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : value,
    );
    for (const fragment of ["Grace", "Hopper", "grace@example.test"]) {
      expect(serialised).not.toContain(fragment);
    }
  });

  it("REQ-ID-3: a seated invitation names a canonical position, and its ticket takes that seat", async () => {
    const context = await setup();
    await context.organiser.client.events.zones.addSeatPositions.mutate({
      event: context.event,
      zone: context.seated,
      positions: ["B-7"],
    });
    const seat = (position: string): CreateInvitationInput => ({
      event: context.event,
      class: context.guests,
      zone: context.seated,
      placement: { kind: "Seated", position },
      guest: null,
    });

    expect(
      await refusal(() => context.organiser.client.events.invitations.create.mutate(seat("b7"))),
    ).toEqual({ code: "BAD_REQUEST", errorCode: null });
    const { invitation, token } = await context.organiser.client.events.invitations.create.mutate(
      seat("B-7"),
    );
    expect(invitation.placement).toEqual({ kind: "Seated", position: "B-7" });

    const { ticket } = await harness.holder().client.events.invitations.redeem.mutate({ token });
    expect((await ticketOnLedger(ticket)).placement).toEqual({
      kind: "Seated",
      position: positionOf("B-7"),
    });
  });

  it("a refused issuance issues nothing, and the invitation stays open", async () => {
    const context = await setup({ quota: 0 });
    const { invitation, token } = await context.organiser.client.events.invitations.create.mutate(
      unseatedInvitation(context),
    );

    expect(
      await refusal(() => harness.holder().client.events.invitations.redeem.mutate({ token })),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-ClassQuotaExceeded" });
    const [listed] = await context.organiser.client.events.invitations.list.query({
      event: context.event,
      class: context.guests,
    });
    expect(listed).toMatchObject({ id: invitation.id, status: "open", holder: null, ticket: null });
  });

  it("an invitation is created only for a granted class and a placement the event defines", async () => {
    const context = await setup();
    const general = await context.organiser.client.events.classes.define.mutate(
      granted(context.event, {
        name: "General",
        provenance: "Purchased",
        price: 10_000,
        restrictions: { cannotResale: false, cannotTransfer: false },
      }),
    );
    const create = (input: Partial<CreateInvitationInput>) =>
      refusal(() =>
        context.organiser.client.events.invitations.create.mutate({
          ...unseatedInvitation(context),
          ...input,
        }),
      );

    expect(await create({ class: randomId() })).toEqual({
      code: "UNPROCESSABLE_CONTENT",
      errorCode: "ERR-UnknownClass",
    });
    expect(await create({ class: general.id })).toEqual({ code: "BAD_REQUEST", errorCode: null });
    expect(await create({ zone: randomId() })).toEqual({
      code: "UNPROCESSABLE_CONTENT",
      errorCode: "ERR-UnknownZone",
    });
    expect(await create({ zone: context.seated })).toEqual({
      code: "UNPROCESSABLE_CONTENT",
      errorCode: "ERR-ZoneKindMismatch",
    });
    expect(
      await refusal(() =>
        harness.holder().client.events.invitations.create.mutate(unseatedInvitation(context)),
      ),
    ).toEqual({ code: "FORBIDDEN", errorCode: null });
    const other = await harness.organiser();
    expect(
      await refusal(() =>
        other.client.events.invitations.create.mutate(unseatedInvitation(context)),
      ),
    ).toEqual({ code: "FORBIDDEN", errorCode: "ERR-NotOwner" });
    expect(
      await refusal(() =>
        other.client.events.invitations.list.query({ event: context.event, class: null }),
      ),
    ).toEqual({ code: "FORBIDDEN", errorCode: "ERR-NotOwner" });
  });

  it("lists an event's invitations by class, and keeps only a hash of each token", async () => {
    const context = await setup();
    const press = await context.organiser.client.events.classes.define.mutate(
      granted(context.event, { name: "Press" }),
    );
    const first = await context.organiser.client.events.invitations.create.mutate(
      unseatedInvitation(context, "First"),
    );
    const second = await context.organiser.client.events.invitations.create.mutate({
      ...unseatedInvitation(context, "Second"),
      class: press.id,
    });

    const all = await context.organiser.client.events.invitations.list.query({
      event: context.event,
      class: null,
    });
    expect(all.map((invitation) => invitation.guest)).toEqual(["First", "Second"]);
    expect(
      await context.organiser.client.events.invitations.list.query({
        event: context.event,
        class: press.id,
      }),
    ).toEqual([second.invitation]);
    expect(JSON.stringify(all)).not.toContain(first.token);

    const stored = await harness.database.store.query(
      "SELECT * FROM invitations WHERE event = $1",
      [context.event],
    );
    expect(JSON.stringify(stored.rows)).not.toContain(first.token);
    expect(JSON.stringify(stored.rows)).not.toContain(second.token);
    // An organiser cannot redeem: redemption needs a holder session.
    expect(
      await refusal(() =>
        context.organiser.client.events.invitations.redeem.mutate({ token: first.token }),
      ),
    ).toEqual({ code: "FORBIDDEN", errorCode: null });
  });
});
