import { createHash } from "node:crypto";
import type { EventId } from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ANONYMOUS } from "../../src/auth/ports.js";
import type { DefineClassInput } from "../../src/events/ports.js";
import { CHECKOUT_LIFETIME_MS } from "../../src/sales/checkout.js";
import type { BeginCheckoutInput, Checkout } from "../../src/sales/ports.js";
import { createSales } from "../../src/sales/service.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  refusal,
  type TestOrganiser,
} from "../support/events.js";

const purchased = (event: string, overrides: Partial<DefineClassInput> = {}): DefineClassInput => ({
  event,
  name: "General admission",
  description: null,
  provenance: "Purchased",
  policy: { kind: "Single" },
  restrictions: { cannotResale: false, cannotTransfer: false },
  quota: null,
  ...overrides,
});

describeWithStore("checkout sessions", () => {
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

  async function setup(): Promise<Setup> {
    const organiser = await harness.organiser();
    const seated = randomId();
    const unseated = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [
        { id: seated, kind: "Seated" },
        { id: unseated, kind: "Unseated" },
      ],
      capacity: 100,
    });
    await organiser.client.events.zones.addSeatPositions.mutate({
      event,
      zone: seated,
      positions: ["A-1", "A-2"],
    });
    const { id: classId } = await organiser.client.events.classes.define.mutate(purchased(event));
    return { organiser, event, seated, unseated, classId };
  }

  const generalAdmission = ({ event, unseated, classId }: Setup): BeginCheckoutInput => ({
    event,
    zone: unseated,
    class: classId,
    placement: { kind: "Unseated" },
  });

  /** The handoff a checkout page shows, while it has no link. */
  const handoffOf = (checkout: Checkout): string => {
    if (checkout.account.state !== "handoff") throw new Error("expected a handoff");
    return checkout.account.handoff.handoffToken;
  };

  it("AC-B4.1: a checkout without a linked account yields a Saifu handoff, and proceeds once Saifu links one and the buyer confirms it", async () => {
    const s = await setup();
    const ichiba = harness.anonymous();

    const { token, checkout } = await ichiba.sales.checkout.begin.mutate(generalAdmission(s));
    const handoffToken = handoffOf(checkout);
    expect(handoffToken).not.toBe(token);
    expect(checkout).toEqual({
      event: s.event,
      zone: s.unseated,
      class: s.classId,
      placement: { kind: "Unseated" },
      account: { state: "handoff", handoff: { handoffToken } },
      hold: null,
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
    });

    // Saifu, signed in as the holder, links the account with the handoff token, and shows a code.
    const saifu = await harness.linkedHolder();
    const linked = await saifu.client.sales.checkout.link.mutate({ handoffToken });
    expect(linked).toEqual({
      event: s.event,
      zone: s.unseated,
      class: s.classId,
      placement: { kind: "Unseated" },
      pairingCode: expect.stringMatching(/^[0-9]{6}$/),
    });

    // The checkout page shows the same code, and the buyer confirms the match.
    expect((await ichiba.sales.checkout.get.query({ token })).account).toEqual({
      state: "pairing",
      pairingCode: linked.pairingCode,
    });
    const confirmed = await ichiba.sales.checkout.confirmLink.mutate({
      token,
      pairingCode: linked.pairingCode,
    });
    expect(confirmed.account).toEqual({ state: "linked", holder: saifu.account });
    expect(
      (await ichiba.sales.checkout.confirmLink.mutate({ token, pairingCode: linked.pairingCode }))
        .account,
    ).toEqual({ state: "linked", holder: saifu.account });
    expect((await ichiba.sales.checkout.hold.mutate({ token })).outcome).toBe("held");
  });

  it("AC-B4.1: a checkout begun with a holder session is linked and confirmed at once, with no handoff", async () => {
    const s = await setup();
    const holder = await harness.linkedHolder();

    const { token, checkout } = await holder.client.sales.checkout.begin.mutate(
      generalAdmission(s),
    );
    expect(checkout.account).toEqual({ state: "linked", holder: holder.account });
    expect((await harness.anonymous().sales.checkout.hold.mutate({ token })).outcome).toBe("held");
  });

  it("REQ-CL-4: a link not confirmed on the checkout page cannot hold", async () => {
    const s = await setup();
    const ichiba = harness.anonymous();
    const { token, checkout } = await ichiba.sales.checkout.begin.mutate(generalAdmission(s));
    const saifu = await harness.linkedHolder();
    const { pairingCode } = await saifu.client.sales.checkout.link.mutate({
      handoffToken: handoffOf(checkout),
    });

    expect(await refusal(() => ichiba.sales.checkout.hold.mutate({ token }))).toEqual({
      code: "PRECONDITION_FAILED",
      errorCode: null,
    });
    const wrong = pairingCode === "000000" ? "000001" : "000000";
    expect(
      await refusal(() => ichiba.sales.checkout.confirmLink.mutate({ token, pairingCode: wrong })),
    ).toEqual({ code: "CONFLICT", errorCode: null });
    expect(await refusal(() => ichiba.sales.checkout.hold.mutate({ token }))).toEqual({
      code: "PRECONDITION_FAILED",
      errorCode: null,
    });
    const holds = await harness.database.store.query("SELECT 1 FROM holds WHERE event = $1", [
      s.event,
    ]);
    expect(holds.rowCount).toBe(0);
  });

  it("the handoff token only links: it cannot read, confirm or hold, and the page's token cannot link", async () => {
    const s = await setup();
    const ichiba = harness.anonymous();
    const { token, checkout } = await ichiba.sales.checkout.begin.mutate(generalAdmission(s));
    const handoffToken = handoffOf(checkout);
    const saifu = await harness.linkedHolder();

    expect(
      await refusal(() => saifu.client.sales.checkout.link.mutate({ handoffToken: token })),
    ).toEqual({ code: "NOT_FOUND", errorCode: null });
    const { pairingCode } = await saifu.client.sales.checkout.link.mutate({ handoffToken });
    expect(await refusal(() => ichiba.sales.checkout.get.query({ token: handoffToken }))).toEqual({
      code: "NOT_FOUND",
      errorCode: null,
    });
    expect(
      await refusal(() =>
        ichiba.sales.checkout.confirmLink.mutate({ token: handoffToken, pairingCode }),
      ),
    ).toEqual({ code: "NOT_FOUND", errorCode: null });
    expect(await refusal(() => ichiba.sales.checkout.hold.mutate({ token: handoffToken }))).toEqual(
      {
        code: "NOT_FOUND",
        errorCode: null,
      },
    );
  });

  it("a discarded link frees the checkout, and replaces the handoff token that was seen", async () => {
    const s = await setup();
    const ichiba = harness.anonymous();
    const { token, checkout } = await ichiba.sales.checkout.begin.mutate(generalAdmission(s));
    const seen = handoffOf(checkout);

    // Someone who saw the QR code links first; the buyer's own Saifu is refused.
    const intruder = await harness.linkedHolder();
    const buyer = await harness.linkedHolder();
    const intruderLink = await intruder.client.sales.checkout.link.mutate({ handoffToken: seen });
    expect(
      await refusal(() => buyer.client.sales.checkout.link.mutate({ handoffToken: seen })),
    ).toEqual({ code: "CONFLICT", errorCode: null });

    // The codes do not match what the buyer's Saifu shows: the buyer discards the link.
    const discarded = await ichiba.sales.checkout.discardLink.mutate({ token });
    const fresh = handoffOf(discarded);
    expect(fresh).not.toBe(seen);
    expect(
      await refusal(() => intruder.client.sales.checkout.link.mutate({ handoffToken: seen })),
    ).toEqual({ code: "NOT_FOUND", errorCode: null });

    const buyerLink = await buyer.client.sales.checkout.link.mutate({ handoffToken: fresh });
    expect((await ichiba.sales.checkout.get.query({ token })).account).toEqual({
      state: "pairing",
      pairingCode: buyerLink.pairingCode,
    });
    const confirmed = await ichiba.sales.checkout.confirmLink.mutate({
      token,
      pairingCode: buyerLink.pairingCode,
    });
    expect(confirmed.account).toEqual({ state: "linked", holder: buyer.account });
    expect(intruderLink.pairingCode).toMatch(/^[0-9]{6}$/);

    // A confirmed link is not discarded.
    expect(await refusal(() => ichiba.sales.checkout.discardLink.mutate({ token }))).toEqual({
      code: "PRECONDITION_FAILED",
      errorCode: null,
    });
  });

  it("links only with a holder session", async () => {
    const s = await setup();
    const { checkout } = await harness.anonymous().sales.checkout.begin.mutate(generalAdmission(s));
    const handoffToken = handoffOf(checkout);

    expect(
      await refusal(() => harness.anonymous().sales.checkout.link.mutate({ handoffToken })),
    ).toEqual({ code: "UNAUTHORIZED", errorCode: null });
    expect(
      await refusal(() => s.organiser.client.sales.checkout.link.mutate({ handoffToken })),
    ).toEqual({ code: "FORBIDDEN", errorCode: null });
  });

  it("names a checkout only by its token, which is stored hashed", async () => {
    const s = await setup();
    const { token } = await harness.anonymous().sales.checkout.begin.mutate(generalAdmission(s));
    const unknown = "A".repeat(43);

    expect(
      await refusal(() => harness.anonymous().sales.checkout.get.query({ token: unknown })),
    ).toEqual({ code: "NOT_FOUND", errorCode: null });
    const holder = await harness.linkedHolder();
    expect(
      await refusal(() => holder.client.sales.checkout.link.mutate({ handoffToken: unknown })),
    ).toEqual({ code: "NOT_FOUND", errorCode: null });

    const stored = await harness.database.store.query<{ token_hash: Buffer }>(
      "SELECT token_hash FROM checkout_sessions",
    );
    const hashes = stored.rows.map((row) => row.token_hash.toString("hex"));
    expect(hashes).toContain(createHash("sha256").update(token).digest("hex"));
    expect(hashes).not.toContain(token);
  });

  it("an idle checkout with no hold expires after an hour; a held one lives on its hold", async () => {
    const s = await setup();
    let clock = new Date();
    const sales = createSales({
      store: harness.database.store,
      ledger: harness.ledger,
      classes: harness.events.classes,
      zones: harness.events.zones,
      seats: harness.events.seats,
      now: () => clock,
    });
    const holder = await harness.linkedHolder();
    const buyer = {
      requestId: "r",
      principal: { kind: "holder" as const, account: holder.account, sessionId: holder.sessionId },
    };
    const idle = await sales.beginCheckout(
      { requestId: "r", principal: ANONYMOUS },
      generalAdmission(s),
    );
    const held = await sales.beginCheckout(buyer, generalAdmission(s));
    await sales.hold(buyer, held.token);
    expect(idle.checkout.expiresAt).toBe(
      new Date(new Date(idle.checkout.createdAt).getTime() + CHECKOUT_LIFETIME_MS).toISOString(),
    );

    clock = new Date(clock.getTime() + CHECKOUT_LIFETIME_MS - 1);
    expect((await sales.checkout(idle.token)).account.state).toBe("handoff");
    clock = new Date(clock.getTime() + 1);
    await expect(sales.checkout(idle.token)).rejects.toMatchObject({ failure: "unknown-checkout" });
    await expect(sales.hold(buyer, idle.token)).rejects.toMatchObject({
      failure: "unknown-checkout",
    });
    await expect(sales.linkCheckout(buyer, handoffOf(idle.checkout))).rejects.toMatchObject({
      failure: "unknown-checkout",
    });

    const heldCheckout = await sales.checkout(held.token);
    expect(heldCheckout.expiresAt).toBeNull();
    expect(heldCheckout.hold?.status).toBe("lapsed");
  });

  it("records a seat as the canonical designation of a seated zone", async () => {
    const s = await setup();
    const { checkout } = await harness.anonymous().sales.checkout.begin.mutate({
      event: s.event,
      zone: s.seated,
      class: s.classId,
      placement: { kind: "Seated", position: "A-2" },
    });
    expect(checkout.placement).toEqual({ kind: "Seated", position: "A-2" });
  });

  it("refuses, before anything is held, what cannot be sold at checkout", async () => {
    const s = await setup();
    const ichiba = harness.anonymous();
    const begin = (input: BeginCheckoutInput) => () => ichiba.sales.checkout.begin.mutate(input);
    const base = generalAdmission(s);

    expect(await refusal(begin({ ...base, event: randomId() }))).toEqual({
      code: "NOT_FOUND",
      errorCode: "ERR-EventNotFound",
    });
    expect(await refusal(begin({ ...base, class: randomId() }))).toEqual({
      code: "UNPROCESSABLE_CONTENT",
      errorCode: "ERR-UnknownClass",
    });
    // A granted class's tickets are free, issued by the organiser (REQ-TC-4).
    const guests = await s.organiser.client.events.classes.define.mutate(
      purchased(s.event, { provenance: "Granted", name: "Guests" }),
    );
    expect(await refusal(begin({ ...base, class: guests.id }))).toEqual({
      code: "BAD_REQUEST",
      errorCode: null,
    });
    expect(await refusal(begin({ ...base, zone: randomId() }))).toEqual({
      code: "UNPROCESSABLE_CONTENT",
      errorCode: "ERR-UnknownZone",
    });
    expect(await refusal(begin({ ...base, zone: s.seated }))).toEqual({
      code: "UNPROCESSABLE_CONTENT",
      errorCode: "ERR-ZoneKindMismatch",
    });
    expect(
      await refusal(
        begin({ ...base, zone: s.seated, placement: { kind: "Seated", position: "a1" } }),
      ),
    ).toEqual({ code: "BAD_REQUEST", errorCode: null });

    const count = await harness.database.store.query<{ count: string }>(
      "SELECT count(*) FROM checkout_sessions WHERE event = $1",
      [s.event],
    );
    expect(count.rows[0]?.count).toBe("0");
  });

  it("refuses an event that is not Active: it is no longer on sale (REQ-EV-8)", async () => {
    // backend-memory cannot yet change an event's status (T-008-04), so the ledger's
    // answer for the event is replaced by one naming each other status in turn.
    const s = await setup();
    const found = await harness.ledger.getEvent(s.event as EventId);
    if (!found.ok) throw new Error(found.error.code);
    for (const [status, code] of [
      ["Sealed", "ERR-EventSealed"],
      ["Cancelled", "ERR-EventCancelled"],
      ["Finished", "ERR-EventFinished"],
    ] as const) {
      const sales = createSales({
        store: harness.database.store,
        ledger: {
          ...harness.ledger,
          getEvent: async () => ({ ok: true, value: { ...found.value, status } }),
        },
        classes: harness.events.classes,
        zones: harness.events.zones,
        seats: harness.events.seats,
      });
      await expect(
        sales.beginCheckout({ requestId: "r", principal: ANONYMOUS }, generalAdmission(s)),
      ).rejects.toMatchObject({ code });
    }
  });

  it("AC-B4.2: a checkout writes nothing to the ledger", async () => {
    const s = await setup();
    const before = harness.sponsored.length;
    const { token, checkout } = await harness
      .anonymous()
      .sales.checkout.begin.mutate(generalAdmission(s));
    const holder = await harness.linkedHolder();
    const { pairingCode } = await holder.client.sales.checkout.link.mutate({
      handoffToken: handoffOf(checkout),
    });
    await harness.anonymous().sales.checkout.confirmLink.mutate({ token, pairingCode });
    await holder.client.sales.checkout.begin.mutate(generalAdmission(s));

    expect(harness.sponsored.length).toBe(before);
  });
});
