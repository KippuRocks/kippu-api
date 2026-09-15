import { randomBytes } from "node:crypto";
import type { EventId, TicketId } from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DefineClassInput, IssueGrantedInput } from "../../src/events/ports.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  refusal,
  type TestOrganiser,
} from "../support/events.js";

const RETURN_URLS = {
  successUrl: "https://ichiba.kippu.example/checkout/paid",
  cancelUrl: "https://ichiba.kippu.example/checkout/cancelled",
};

const classInput = (
  event: string,
  name: string,
  provenance: DefineClassInput["provenance"],
): DefineClassInput => ({
  event,
  name,
  description: null,
  provenance,
  policy: { kind: "Single" },
  restrictions: { cannotResale: false, cannotTransfer: false },
  quota: null,
  price: provenance === "Purchased" ? 25_000 : null,
});

describeWithStore("seal, cancel and finish", () => {
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
    readonly zone: string;
    readonly stalls: string;
    readonly guests: string;
  }

  async function setup(): Promise<Setup> {
    const organiser = await harness.organiser();
    const zone = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: zone, kind: "Unseated" }],
      capacity: 50,
      saleAsset: "COPM/2",
    });
    const stalls = await organiser.client.events.classes.define.mutate(
      classInput(event, "Stalls", "Purchased"),
    );
    const guests = await organiser.client.events.classes.define.mutate(
      classInput(event, "Guests", "Granted"),
    );
    return { organiser, event, zone, stalls: stalls.id, guests: guests.id };
  }

  const grant = (context: Setup): IssueGrantedInput => ({
    event: context.event,
    class: context.guests,
    zone: context.zone,
    placement: { kind: "Unseated" },
    holder: randomBytes(32).toString("hex"),
  });

  /** A buyer's checkout of the sold class, held: its token. */
  async function held(context: Setup): Promise<string> {
    const buyer = await harness.linkedHolder();
    const { token } = await buyer.client.sales.checkout.begin.mutate({
      event: context.event,
      zone: context.zone,
      class: context.stalls,
      placement: { kind: "Unseated" },
    });
    expect(await harness.anonymous().sales.checkout.hold.mutate({ token })).toMatchObject({
      outcome: "held",
    });
    return token;
  }

  /** A completed purchase through checkout: its sold ticket. */
  async function purchase(context: Setup): Promise<string> {
    const token = await held(context);
    const ichiba = harness.anonymous();
    const payment = await ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS });
    const id = payment.url.split("/").at(-1) as string;
    harness.payments.pay(id);
    await harness.sales.payments.reconcile("webhook", id);
    const { sale } = await ichiba.sales.checkout.get.query({ token });
    expect(sale?.status).toBe("issued");
    return sale?.ticket as string;
  }

  const statusOf = async (event: string) => {
    const found = await harness.ledger.getEvent(event as EventId);
    if (!found.ok) throw new Error(found.error.code);
    return found.value.status;
  };

  const holdStatuses = async (event: string) =>
    (
      await harness.database.store.query<{ status: string }>(
        "SELECT status FROM holds WHERE event = $1 ORDER BY created_at",
        [event],
      )
    ).rows.map((row) => row.status);

  it("AC-A4.1: sealing releases the event's holds first, then records Sealed; issuance fails thereafter", async () => {
    const context = await setup();
    await held(context);

    const sealed = await context.organiser.client.events.seal.mutate({ event: context.event });

    expect(sealed).toEqual({ event: context.event, status: "Sealed", cursor: expect.any(String) });
    expect(await statusOf(context.event)).toBe("Sealed");
    // REQ-HD-4: the outstanding hold was released, and nothing more can be held.
    expect(await holdStatuses(context.event)).toEqual(["released"]);
    const buyer = await harness.linkedHolder();
    const late = await buyer.client.sales.checkout.begin
      .mutate({
        event: context.event,
        zone: context.zone,
        class: context.stalls,
        placement: { kind: "Unseated" },
      })
      .catch((error: unknown) => error);
    expect(late).toBeInstanceOf(Error);
    expect(
      await refusal(() =>
        context.organiser.client.events.tickets.issueGranted.mutate(grant(context)),
      ),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-EventSealed" });
  });

  it("AC-A5.1: an Active or a Sealed event can be cancelled", async () => {
    const active = await setup();
    expect(
      await active.organiser.client.events.cancel.mutate({ event: active.event }),
    ).toMatchObject({ status: "Cancelled", cursor: expect.any(String) });
    expect(await statusOf(active.event)).toBe("Cancelled");

    const sealed = await setup();
    await sealed.organiser.client.events.seal.mutate({ event: sealed.event });
    await sealed.organiser.client.events.cancel.mutate({ event: sealed.event });
    expect(await statusOf(sealed.event)).toBe("Cancelled");
  });

  it("AC-A5.2: once Cancelled, attendance is refused", async () => {
    const context = await setup();
    const { ticket } = await context.organiser.client.events.tickets.issueGranted.mutate(
      grant(context),
    );
    await context.organiser.client.events.cancel.mutate({ event: context.event });

    expect(await harness.ledger.canAttend(context.event as EventId, ticket as TicketId)).toEqual({
      ok: true,
      value: { admit: false, reason: "ERR-EventCancelled" },
    });
  });

  it("AC-A5.3: once Cancelled, nothing of the event can be sold: holds released, sales closed", async () => {
    const context = await setup();
    await held(context);
    await context.organiser.client.events.cancel.mutate({ event: context.event });

    expect(await holdStatuses(context.event)).toEqual(["released"]);
    expect(await harness.anonymous().sales.inventory.query({ event: context.event })).toMatchObject(
      { onSale: false },
    );
    const buyer = await harness.linkedHolder();
    await expect(
      buyer.client.sales.checkout.begin.mutate({
        event: context.event,
        zone: context.zone,
        class: context.stalls,
        placement: { kind: "Unseated" },
      }),
    ).rejects.toThrow();
  });

  it("AC-A5.5: cancelling records one refund entitlement per purchased ticket, and cancelling again adds none", async () => {
    const context = await setup();
    const first = await purchase(context);
    const second = await purchase(context);
    await context.organiser.client.events.tickets.issueGranted.mutate(grant(context));

    await context.organiser.client.events.cancel.mutate({ event: context.event });

    const entitled = async () =>
      (
        await harness.database.store.query<{ ticket: string }>(
          "SELECT ticket FROM refund_entitlements WHERE reason = 'event-cancelled' AND ticket = ANY($1) ORDER BY ticket",
          [[first, second]],
        )
      ).rows.map((row) => row.ticket);
    expect(await entitled()).toEqual([first, second].sort());

    // Retrying a cancellation records what is missing, and nothing twice.
    expect(await context.organiser.client.events.cancel.mutate({ event: context.event })).toEqual({
      event: context.event,
      status: "Cancelled",
      cursor: null,
    });
    expect(await entitled()).toEqual([first, second].sort());
  });

  it("AC-A5.8: a transition the ledger does not permit is refused, and sales reopen", async () => {
    const context = await setup();
    await context.organiser.client.events.finish.mutate({ event: context.event });

    expect(
      await refusal(() => context.organiser.client.events.seal.mutate({ event: context.event })),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-EventFinished" });
    const reopened = await harness.database.store.query<{ open: number }>(
      "SELECT count(*)::int AS open FROM event_sale_closures WHERE event = $1 AND reopened_at IS NULL",
      [context.event],
    );
    // Finishing closed the Active event's sales for good; the refused seal reopened only its own.
    expect(reopened.rows[0]?.open).toBe(1);

    const sealed = await setup();
    await sealed.organiser.client.events.seal.mutate({ event: sealed.event });
    expect(
      await refusal(() => sealed.organiser.client.events.seal.mutate({ event: sealed.event })),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-InvalidTransition" });
  });

  it("REQ-EV-12: finishing an Active event closes its sales first; a Sealed one has nothing to release", async () => {
    const active = await setup();
    await held(active);
    expect(
      await active.organiser.client.events.finish.mutate({ event: active.event }),
    ).toMatchObject({ status: "Finished" });
    expect(await statusOf(active.event)).toBe("Finished");
    expect(await holdStatuses(active.event)).toEqual(["released"]);

    const sealed = await setup();
    await sealed.organiser.client.events.seal.mutate({ event: sealed.event });
    const closures = async () =>
      Number(
        (
          await harness.database.store.query<{ n: string }>(
            "SELECT count(*) AS n FROM event_sale_closures WHERE event = $1",
            [sealed.event],
          )
        ).rows[0]?.n,
      );
    const beforeFinish = await closures();
    await sealed.organiser.client.events.finish.mutate({ event: sealed.event });
    expect(await statusOf(sealed.event)).toBe("Finished");
    expect(await closures()).toBe(beforeFinish);
  });

  it("ERR-NotOwner: only the event's organiser changes its status", async () => {
    const context = await setup();
    const other = await harness.organiser();
    for (const call of [
      () => other.client.events.seal.mutate({ event: context.event }),
      () => other.client.events.cancel.mutate({ event: context.event }),
      () => other.client.events.finish.mutate({ event: context.event }),
    ]) {
      expect(await refusal(call)).toEqual({ code: "FORBIDDEN", errorCode: "ERR-NotOwner" });
    }
    expect(await statusOf(context.event)).toBe("Active");
    expect(await holdStatuses(context.event)).toEqual([]);
  });
});
