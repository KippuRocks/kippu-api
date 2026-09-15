import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DefineClassInput } from "../../src/events/ports.js";
import { HOLD_EXTENSION_MS, HOLD_LIFETIME_MS, lapseSweeper } from "../../src/sales/holds.js";
import type { BeginCheckoutInput, HoldOutcome, SalesRequest } from "../../src/sales/ports.js";
import { createSales } from "../../src/sales/service.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  refusal,
  type TestOrganiser,
} from "../support/events.js";

const classInput = (
  event: string,
  overrides: Partial<DefineClassInput> = {},
): DefineClassInput => ({
  event,
  name: "Stalls",
  description: null,
  provenance: "Purchased",
  policy: { kind: "Single" },
  restrictions: { cannotResale: false, cannotTransfer: false },
  quota: null,
  price: 25_000,
  ...overrides,
});

/** How many buyers race for one ticket in the concurrency tests. */
const BUYERS = 8;

describeWithStore("issuance holds", () => {
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
    readonly classId: string;
  }

  async function setup(
    capacity: number | null,
    overrides: Partial<DefineClassInput> = {},
  ): Promise<Setup> {
    const organiser = await harness.organiser();
    const seated = randomId();
    const unseated = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [
        { id: seated, kind: "Seated" },
        { id: unseated, kind: "Unseated" },
      ],
      capacity,
      saleAsset: "COPM/2",
    });
    await organiser.client.events.zones.addSeatPositions.mutate({
      event,
      zone: seated,
      positions: ["A-1", "A-2", "A-3"],
    });
    const { id: classId } = await organiser.client.events.classes.define.mutate(
      classInput(event, overrides),
    );
    return { organiser, event, seated, unseated, classId };
  }

  const generalAdmission = ({ event, unseated, classId }: Setup): BeginCheckoutInput => ({
    event,
    zone: unseated,
    class: classId,
    placement: { kind: "Unseated" },
  });

  const seat = ({ event, seated, classId }: Setup, position: string): BeginCheckoutInput => ({
    event,
    zone: seated,
    class: classId,
    placement: { kind: "Seated", position },
  });

  /** A buyer's checkout, linked to their account, ready to hold: its token. */
  async function linkedCheckout(input: BeginCheckoutInput): Promise<string> {
    const buyer = await harness.linkedHolder();
    const { token } = await buyer.client.sales.checkout.begin.mutate(input);
    return token;
  }

  const outstanding = async (event: string) =>
    Number(
      (
        await harness.database.store.query<{ count: string }>(
          "SELECT count(*) FROM holds WHERE event = $1 AND status = 'outstanding'",
          [event],
        )
      ).rows[0]?.count,
    );

  const outcomes = (results: readonly HoldOutcome[]) =>
    results.map((result) => (result.outcome === "held" ? "held" : result.reason)).sort();

  it("AC-B4.4: second buyer is refused before paying — for the last ticket, under concurrency", async () => {
    const s = await setup(1);
    const tokens = await Promise.all(
      Array.from({ length: BUYERS }, () => linkedCheckout(generalAdmission(s))),
    );

    const results = await Promise.all(
      tokens.map((token) => harness.anonymous().sales.checkout.hold.mutate({ token })),
    );

    expect(outcomes(results)).toEqual(["held", ...Array(BUYERS - 1).fill("sold-out")]);
    expect(await outstanding(s.event)).toBe(1);
  });

  it("AC-B4.4: second buyer is refused before paying — for the same seat, under concurrency", async () => {
    const s = await setup(100);
    const tokens = await Promise.all(
      Array.from({ length: BUYERS }, () => linkedCheckout(seat(s, "A-1"))),
    );

    const results = await Promise.all(
      tokens.map((token) => harness.anonymous().sales.checkout.hold.mutate({ token })),
    );

    expect(outcomes(results)).toEqual(["held", ...Array(BUYERS - 1).fill("seat-taken")]);
    expect(await outstanding(s.event)).toBe(1);
    // Another seat of the zone is still free.
    const other = await linkedCheckout(seat(s, "A-2"));
    expect((await harness.anonymous().sales.checkout.hold.mutate({ token: other })).outcome).toBe(
      "held",
    );
  });

  it("REQ-TC-5: holds count against the class quota, under concurrency", async () => {
    const s = await setup(null, { quota: 2 });
    const tokens = await Promise.all(
      Array.from({ length: BUYERS }, () => linkedCheckout(generalAdmission(s))),
    );

    const results = await Promise.all(
      tokens.map((token) => harness.anonymous().sales.checkout.hold.mutate({ token })),
    );

    expect(outcomes(results)).toEqual(
      ["class-sold-out", ...Array(BUYERS - 3).fill("class-sold-out"), "held", "held"].sort(),
    );
  });

  it("INV-4: holds count against capacity together with the tickets already issued", async () => {
    const s = await setup(2);
    const guests = await s.organiser.client.events.classes.define.mutate(
      classInput(s.event, { provenance: "Granted", name: "Guests", price: null }),
    );
    await s.organiser.client.events.tickets.issueGranted.mutate({
      event: s.event,
      class: guests.id,
      zone: s.unseated,
      placement: { kind: "Unseated" },
      holder: randomBytes(32).toString("hex"),
    });

    const first = await linkedCheckout(generalAdmission(s));
    const second = await linkedCheckout(generalAdmission(s));
    expect((await harness.anonymous().sales.checkout.hold.mutate({ token: first })).outcome).toBe(
      "held",
    );
    expect(await harness.anonymous().sales.checkout.hold.mutate({ token: second })).toEqual({
      outcome: "refused",
      reason: "sold-out",
    });
  });

  it("AC-B5.2: a seat already issued is refused before paying", async () => {
    const s = await setup(100);
    const guests = await s.organiser.client.events.classes.define.mutate(
      classInput(s.event, { provenance: "Granted", name: "Guests", price: null }),
    );
    await s.organiser.client.events.tickets.issueGranted.mutate({
      event: s.event,
      class: guests.id,
      zone: s.seated,
      placement: { kind: "Seated", position: "A-3" },
      holder: randomBytes(32).toString("hex"),
    });

    const token = await linkedCheckout(seat(s, "A-3"));
    expect(await harness.anonymous().sales.checkout.hold.mutate({ token })).toEqual({
      outcome: "refused",
      reason: "seat-taken",
    });
    expect(await outstanding(s.event)).toBe(0);
  });

  it("AC-B4.1: a checkout with no holder account cannot hold", async () => {
    const s = await setup(1);
    const { token } = await harness.anonymous().sales.checkout.begin.mutate(generalAdmission(s));

    expect(await refusal(() => harness.anonymous().sales.checkout.hold.mutate({ token }))).toEqual({
      code: "PRECONDITION_FAILED",
      errorCode: null,
    });
    expect(await outstanding(s.event)).toBe(0);
  });

  it("REQ-HD-2: a hold is a Kippu fact: asking again answers with the same hold, and nothing reaches the ledger", async () => {
    const s = await setup(5);
    const token = await linkedCheckout(generalAdmission(s));
    const sponsoredBefore = harness.sponsored.length;
    const issuedBefore = await harness.ledger.getEvent(s.event as never);

    const first = await harness.anonymous().sales.checkout.hold.mutate({ token });
    const again = await harness.anonymous().sales.checkout.hold.mutate({ token });

    expect(first.outcome).toBe("held");
    expect(again).toEqual(first);
    if (first.outcome !== "held") throw new Error("expected a hold");
    expect(first.checkout.hold).toEqual({
      status: "outstanding",
      expiresAt: expect.any(String),
      extended: false,
      asset: "COPM/2",
      price: 25_000,
    });
    expect(await outstanding(s.event)).toBe(1);
    expect(harness.sponsored.length).toBe(sponsoredBefore);
    expect(await harness.ledger.getEvent(s.event as never)).toEqual(issuedBefore);
  });

  interface Clocked {
    readonly sales: ReturnType<typeof createSales>;
    readonly advance: (ms: number) => void;
    readonly request: () => Promise<SalesRequest>;
  }

  /** The sales services over the harness's store and ledger, with a clock the test moves. */
  function clocked(): Clocked {
    let clock = new Date();
    const sales = createSales(harness.salesOptions({ now: () => clock }));
    return {
      sales,
      advance: (ms) => {
        clock = new Date(clock.getTime() + ms);
      },
      request: async () => {
        const holder = await harness.linkedHolder();
        return {
          requestId: randomBytes(8).toString("hex"),
          principal: { kind: "holder", account: holder.account, sessionId: holder.sessionId },
        };
      },
    };
  }

  it("REQ-HD-1: a hold lives 10 minutes; once lapsed it no longer counts, and its checkout is over", async () => {
    const s = await setup(1);
    const { sales, advance, request } = clocked();
    const buyer = await request();
    const { token } = await sales.beginCheckout(buyer, generalAdmission(s));
    const held = await sales.hold(buyer, token);
    if (held.outcome !== "held") throw new Error("expected a hold");
    const placedAt = new Date(held.checkout.createdAt).getTime();
    expect(
      new Date(held.checkout.hold?.expiresAt ?? 0).getTime() - placedAt,
    ).toBeGreaterThanOrEqual(HOLD_LIFETIME_MS);

    const rival = await request();
    const { token: rivalToken } = await sales.beginCheckout(rival, generalAdmission(s));
    advance(HOLD_LIFETIME_MS - 1000);
    expect(await sales.hold(rival, rivalToken)).toEqual({ outcome: "refused", reason: "sold-out" });

    advance(1000);
    expect((await sales.checkout(token)).hold?.status).toBe("lapsed");
    expect((await sales.hold(rival, rivalToken)).outcome).toBe("held");
    await expect(sales.hold(buyer, token)).rejects.toMatchObject({ failure: "hold-ended" });
  });

  it("extends a hold once, by 5 minutes, when payment starts — never after it lapsed", async () => {
    const s = await setup(10);
    const { sales, advance, request } = clocked();
    const buyer = await request();
    const { token } = await sales.beginCheckout(buyer, generalAdmission(s));
    const held = await sales.hold(buyer, token);
    if (held.outcome !== "held" || held.checkout.hold === null) throw new Error("expected a hold");
    const expiresAt = new Date(held.checkout.hold.expiresAt).getTime();
    const checkoutId = (
      await harness.database.store.query<{ checkout_id: string }>(
        "SELECT checkout_id FROM holds WHERE event = $1",
        [s.event],
      )
    ).rows[0]?.checkout_id as string;

    expect(await sales.holds.extend(checkoutId)).toBe(true);
    expect(await sales.holds.extend(checkoutId)).toBe(false);
    const extended = (await sales.checkout(token)).hold;
    expect(extended?.extended).toBe(true);
    expect(new Date(extended?.expiresAt ?? 0).getTime()).toBe(expiresAt + HOLD_EXTENSION_MS);

    advance(HOLD_LIFETIME_MS + HOLD_EXTENSION_MS);
    expect((await sales.checkout(token)).hold?.status).toBe("lapsed");

    const late = await request();
    const { token: lateToken } = await sales.beginCheckout(late, generalAdmission(s));
    await sales.hold(late, lateToken);
    advance(HOLD_LIFETIME_MS);
    const lateId = (
      await harness.database.store.query<{ checkout_id: string }>(
        "SELECT checkout_id FROM holds WHERE event = $1 AND extended_at IS NULL",
        [s.event],
      )
    ).rows[0]?.checkout_id as string;
    expect(await sales.holds.extend(lateId)).toBe(false);
  });

  it("REQ-HD-1: a released hold no longer counts", async () => {
    const s = await setup(1);
    const { sales, request } = clocked();
    const buyer = await request();
    const { token } = await sales.beginCheckout(buyer, generalAdmission(s));
    await sales.hold(buyer, token);
    const checkoutId = (
      await harness.database.store.query<{ checkout_id: string }>(
        "SELECT checkout_id FROM holds WHERE event = $1",
        [s.event],
      )
    ).rows[0]?.checkout_id as string;

    expect(await sales.holds.release(checkoutId)).toBe(true);
    expect(await sales.holds.release(checkoutId)).toBe(false);
    expect((await sales.checkout(token)).hold?.status).toBe("released");

    const next = await request();
    const { token: nextToken } = await sales.beginCheckout(next, generalAdmission(s));
    expect((await sales.hold(next, nextToken)).outcome).toBe("held");
  });

  it("records lapsed holds in the background", async () => {
    const s = await setup(10);
    const { sales, advance, request } = clocked();
    const buyer = await request();
    const { token } = await sales.beginCheckout(buyer, generalAdmission(s));
    await sales.hold(buyer, token);
    advance(HOLD_LIFETIME_MS);

    const sweeper = lapseSweeper(
      sales.holds,
      (error) => {
        throw error;
      },
      10,
    );
    sweeper.start();
    await expect
      .poll(
        async () =>
          (
            await harness.database.store.query<{ status: string; ended_at: Date | null }>(
              "SELECT status, ended_at FROM holds WHERE event = $1",
              [s.event],
            )
          ).rows,
      )
      .toEqual([{ status: "lapsed", ended_at: expect.any(Date) }]);
    await sweeper.stop();
  });
});
