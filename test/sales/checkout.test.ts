import { createHash } from "node:crypto";
import type { EventId } from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ANONYMOUS } from "../../src/auth/ports.js";
import type { DefineClassInput } from "../../src/events/ports.js";
import type { BeginCheckoutInput } from "../../src/sales/ports.js";
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

  it("AC-B4.1: a checkout without a linked account yields a Saifu handoff, and proceeds once Saifu links one", async () => {
    const s = await setup();
    const ichiba = harness.anonymous();

    const { token, checkout } = await ichiba.sales.checkout.begin.mutate(generalAdmission(s));
    expect(checkout).toEqual({
      event: s.event,
      zone: s.unseated,
      class: s.classId,
      placement: { kind: "Unseated" },
      account: { state: "handoff", handoff: { token } },
      hold: null,
      createdAt: expect.any(String),
    });

    // Saifu, signed in as the holder, links the account with the handoff's token.
    const saifu = await harness.linkedHolder();
    const linked = await saifu.client.sales.checkout.link.mutate({ token });
    expect(linked.account).toEqual({ state: "linked", holder: saifu.account });

    // Ichiba, still anonymous, sees the checkout proceed with the linked account.
    expect((await ichiba.sales.checkout.get.query({ token })).account).toEqual({
      state: "linked",
      holder: saifu.account,
    });
  });

  it("AC-B4.1: a checkout begun with a holder session is linked at once, with no handoff", async () => {
    const s = await setup();
    const holder = await harness.linkedHolder();

    const { token, checkout } = await holder.client.sales.checkout.begin.mutate(
      generalAdmission(s),
    );
    expect(checkout.account).toEqual({ state: "linked", holder: holder.account });
    expect((await harness.anonymous().sales.checkout.get.query({ token })).account).toEqual({
      state: "linked",
      holder: holder.account,
    });
  });

  it("links once: the same account again changes nothing, and another account is refused", async () => {
    const s = await setup();
    const { token } = await harness.anonymous().sales.checkout.begin.mutate(generalAdmission(s));
    const first = await harness.linkedHolder();
    const second = await harness.linkedHolder();

    await first.client.sales.checkout.link.mutate({ token });
    expect((await first.client.sales.checkout.link.mutate({ token })).account).toEqual({
      state: "linked",
      holder: first.account,
    });
    expect(await refusal(() => second.client.sales.checkout.link.mutate({ token }))).toEqual({
      code: "CONFLICT",
      errorCode: null,
    });
    expect((await harness.anonymous().sales.checkout.get.query({ token })).account).toEqual({
      state: "linked",
      holder: first.account,
    });
  });

  it("links only with a holder session", async () => {
    const s = await setup();
    const { token } = await harness.anonymous().sales.checkout.begin.mutate(generalAdmission(s));

    expect(await refusal(() => harness.anonymous().sales.checkout.link.mutate({ token }))).toEqual({
      code: "UNAUTHORIZED",
      errorCode: null,
    });
    expect(await refusal(() => s.organiser.client.sales.checkout.link.mutate({ token }))).toEqual({
      code: "FORBIDDEN",
      errorCode: null,
    });
    expect((await harness.anonymous().sales.checkout.get.query({ token })).account.state).toBe(
      "handoff",
    );
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
      await refusal(() => holder.client.sales.checkout.link.mutate({ token: unknown })),
    ).toEqual({ code: "NOT_FOUND", errorCode: null });

    const stored = await harness.database.store.query<{ token_hash: Buffer }>(
      "SELECT token_hash FROM checkout_sessions",
    );
    const hashes = stored.rows.map((row) => row.token_hash.toString("hex"));
    expect(hashes).toContain(createHash("sha256").update(token).digest("hex"));
    expect(hashes).not.toContain(token);
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
    const { token } = await harness.anonymous().sales.checkout.begin.mutate(generalAdmission(s));
    const holder = await harness.linkedHolder();
    await holder.client.sales.checkout.link.mutate({ token });
    await holder.client.sales.checkout.begin.mutate(generalAdmission(s));

    expect(harness.sponsored.length).toBe(before);
  });
});
