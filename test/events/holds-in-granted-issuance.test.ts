import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DefineClassInput, IssueGrantedInput } from "../../src/events/ports.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  refusal,
  refusalWithReason,
  type TestOrganiser,
} from "../support/events.js";

const classInput = (
  event: string,
  name: string,
  overrides: Partial<DefineClassInput> = {},
): DefineClassInput => ({
  event,
  name,
  description: null,
  provenance: "Granted",
  policy: { kind: "Single" },
  restrictions: { cannotResale: false, cannotTransfer: false },
  quota: null,
  ...overrides,
});

describeWithStore("outstanding holds in granted issuance and invitations", () => {
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
    /** A class sold through checkout. */
    readonly stalls: string;
    /** A guest-list class. */
    readonly guests: string;
  }

  async function setup(capacity: number | null): Promise<Setup> {
    const organiser = await harness.organiser();
    const seated = randomId();
    const unseated = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [
        { id: seated, kind: "Seated" },
        { id: unseated, kind: "Unseated" },
      ],
      capacity,
      saleAsset: "DUSD/6",
    });
    await organiser.client.events.zones.addSeatPositions.mutate({
      event,
      zone: seated,
      positions: ["A-1", "A-2"],
    });
    const stalls = await organiser.client.events.classes.define.mutate(
      classInput(event, "Stalls", { provenance: "Purchased", price: 20_000_000 }),
    );
    const guests = await organiser.client.events.classes.define.mutate(classInput(event, "Guests"));
    return { organiser, event, seated, unseated, stalls: stalls.id, guests: guests.id };
  }

  /** A buyer's checkout holding a ticket of the sold class: its checkout id. */
  async function hold(context: Setup, position: string | null): Promise<string> {
    const buyer = await harness.linkedHolder();
    const { token } = await buyer.client.sales.checkout.begin.mutate({
      event: context.event,
      class: context.stalls,
      ...(position === null
        ? { zone: context.unseated, placement: { kind: "Unseated" as const } }
        : { zone: context.seated, placement: { kind: "Seated" as const, position } }),
    });
    expect(await harness.anonymous().sales.checkout.hold.mutate({ token })).toMatchObject({
      outcome: "held",
    });
    const held = await harness.database.store.query<{ checkout_id: string }>(
      "SELECT checkout_id FROM holds WHERE event = $1 AND status = 'outstanding' ORDER BY created_at DESC LIMIT 1",
      [context.event],
    );
    return held.rows[0]?.checkout_id as string;
  }

  const grant = (context: Setup, position: string | null): IssueGrantedInput => ({
    event: context.event,
    class: context.guests,
    ...(position === null
      ? { zone: context.unseated, placement: { kind: "Unseated" } }
      : { zone: context.seated, placement: { kind: "Seated", position } }),
    holder: randomBytes(32).toString("hex"),
  });

  /** Signs, sponsorships and records: what an issuance leaves behind if it was submitted. */
  async function traces() {
    const count = async (sql: string) =>
      Number((await harness.database.store.query<{ n: string }>(sql)).rows[0]?.n);
    return {
      audited: await count(
        "SELECT count(*) AS n FROM audit_log WHERE command_kind = 'issueTicket'",
      ),
      recorded: await count("SELECT count(*) AS n FROM granted_issuances"),
      sponsored: harness.sponsored.length,
    };
  }

  it("REQ-HD-3: a hold on the last place makes granted issuance refuse", async () => {
    const context = await setup(1);
    const checkout = await hold(context, null);
    const before = await traces();

    expect(
      await refusal(() =>
        context.organiser.client.events.tickets.issueGranted.mutate(grant(context, null)),
      ),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-CapacityExceeded" });
    expect(await traces()).toEqual(before);

    // Once the buyer's hold is released, the place is the organiser's to grant.
    expect(await harness.sales.holds.release(checkout)).toBe(true);
    await expect(
      context.organiser.client.events.tickets.issueGranted.mutate(grant(context, null)),
    ).resolves.toMatchObject({ ticket: expect.any(String) });
  });

  it("REQ-HD-3: a seat a buyer is holding is refused to granted issuance, before submission", async () => {
    const context = await setup(null);
    await hold(context, "A-1");
    const before = await traces();

    expect(
      await refusal(() =>
        context.organiser.client.events.tickets.issueGranted.mutate(grant(context, "A-1")),
      ),
    ).toEqual({ code: "CONFLICT", errorCode: null });
    expect(await traces()).toEqual(before);
    await expect(
      context.organiser.client.events.tickets.issueGranted.mutate(grant(context, "A-2")),
    ).resolves.toMatchObject({ ticket: expect.any(String) });
  });

  it("REQ-HD-3: redeeming an invitation for the last place a buyer holds is refused, and the invitation stays open", async () => {
    const context = await setup(1);
    const { invitation, token } = await context.organiser.client.events.invitations.create.mutate({
      event: context.event,
      class: context.guests,
      zone: context.unseated,
      placement: { kind: "Unseated" },
      guest: null,
    });
    await hold(context, null);

    expect(
      await refusal(() => harness.holder().client.events.invitations.redeem.mutate({ token })),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-CapacityExceeded" });
    const [listed] = await context.organiser.client.events.invitations.list.query({
      event: context.event,
      class: null,
    });
    expect(listed).toMatchObject({ id: invitation.id, status: "open" });
  });

  it("REQ-HD-3: holds and granted issuances racing for the last place take it once", async () => {
    const context = await setup(1);
    const buyers = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const buyer = await harness.linkedHolder();
        return buyer.client.sales.checkout.begin.mutate({
          event: context.event,
          class: context.stalls,
          zone: context.unseated,
          placement: { kind: "Unseated" },
        });
      }),
    );

    const results = await Promise.allSettled([
      ...buyers.map(({ token }) => harness.anonymous().sales.checkout.hold.mutate({ token })),
      ...Array.from({ length: 4 }, () =>
        context.organiser.client.events.tickets.issueGranted.mutate(grant(context, null)),
      ),
    ]);

    const held = results.filter(
      (result) =>
        result.status === "fulfilled" && (result.value as { outcome?: string }).outcome === "held",
    );
    const issued = results.filter(
      (result) => result.status === "fulfilled" && "ticket" in (result.value as object),
    );
    expect(held.length + issued.length).toBe(1);
  });
  it("a refused redemption says why in error.data.reason, beside its transport and §10 codes", async () => {
    const context = await setup(1);
    const invite = async (
      placement: { zone: string; position: string | null },
      classId = context.guests,
    ) =>
      context.organiser.client.events.invitations.create.mutate({
        event: context.event,
        class: classId,
        zone: placement.zone,
        placement:
          placement.position === null
            ? { kind: "Unseated" }
            : { kind: "Seated", position: placement.position },
        guest: null,
      });
    const redeem = (token: string) =>
      refusalWithReason(() => harness.holder().client.events.invitations.redeem.mutate({ token }));

    expect(await redeem("B".repeat(43))).toEqual({
      code: "NOT_FOUND",
      errorCode: null,
      reason: "unknown-invitation",
    });

    // seat-held: a buyer holds the invitation's seat.
    const heldSeat = await invite({ zone: context.seated, position: "A-1" });
    await hold(context, "A-1");
    expect(await redeem(heldSeat.token)).toEqual({
      code: "CONFLICT",
      errorCode: null,
      reason: "seat-held",
    });

    // sold-out: the hold takes the event's one place.
    const unseated = await invite({ zone: context.unseated, position: null });
    expect(await redeem(unseated.token)).toEqual({
      code: "UNPROCESSABLE_CONTENT",
      errorCode: "ERR-CapacityExceeded",
      reason: "sold-out",
    });

    // class-sold-out, seat-taken and already-redeemed, on an event with room.
    const roomy = await setup(null);
    const closed = await roomy.organiser.client.events.classes.define.mutate(
      classInput(roomy.event, "Closed list", { quota: 0 }),
    );
    const quotaInvitation = await roomy.organiser.client.events.invitations.create.mutate({
      event: roomy.event,
      class: closed.id,
      zone: roomy.unseated,
      placement: { kind: "Unseated" },
      guest: null,
    });
    expect(await redeem(quotaInvitation.token)).toEqual({
      code: "UNPROCESSABLE_CONTENT",
      errorCode: "ERR-ClassQuotaExceeded",
      reason: "class-sold-out",
    });

    const seatInvitation = await roomy.organiser.client.events.invitations.create.mutate({
      event: roomy.event,
      class: roomy.guests,
      zone: roomy.seated,
      placement: { kind: "Seated", position: "A-2" },
      guest: null,
    });
    await roomy.organiser.client.events.tickets.issueGranted.mutate(grant(roomy, "A-2"));
    expect(await redeem(seatInvitation.token)).toEqual({
      code: "CONFLICT",
      errorCode: "ERR-TicketIdExists",
      reason: "seat-taken",
    });

    const open = await roomy.organiser.client.events.invitations.create.mutate({
      event: roomy.event,
      class: roomy.guests,
      zone: roomy.unseated,
      placement: { kind: "Unseated" },
      guest: null,
    });
    await harness.holder().client.events.invitations.redeem.mutate({ token: open.token });
    expect(await redeem(open.token)).toEqual({
      code: "CONFLICT",
      errorCode: null,
      reason: "already-redeemed",
    });

    // A refusal elsewhere carries no reason.
    expect(
      await refusalWithReason(() =>
        roomy.organiser.client.events.tickets.issueGranted.mutate({
          ...grant(roomy, null),
          class: closed.id,
        }),
      ),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-ClassQuotaExceeded", reason: null });
  });
});
