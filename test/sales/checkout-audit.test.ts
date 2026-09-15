import { randomBytes } from "node:crypto";
import type { ZoneId } from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import { primarySaleTrail } from "../../src/sales/audit.js";
import { PAYMENT_WEBHOOK_PATH } from "../../src/sales/payment.js";
import { createSales } from "../../src/sales/service.js";
import { describeWithStore } from "../support/database.js";
import { type EventsHarness, eventsHarness, randomId } from "../support/events.js";

const RETURN_URLS = {
  successUrl: "https://ichiba.kippu.example/checkout/paid",
  cancelUrl: "https://ichiba.kippu.example/checkout/cancelled",
};

describeWithStore("primary checkout audit records", () => {
  let harness: EventsHarness;

  beforeAll(async () => {
    harness = await eventsHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  async function onSale() {
    const organiser = await harness.organiser();
    const zone = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: zone, kind: "Unseated" }],
      capacity: 10,
      saleAsset: "COPM/2",
    });
    const stalls = await organiser.client.events.classes.define.mutate({
      event,
      name: "Stalls",
      description: null,
      provenance: "Purchased",
      policy: { kind: "Single" },
      restrictions: { cannotResale: false, cannotTransfer: false },
      quota: null,
      price: 25_000,
    });
    return { organiser, event, zone, classId: stalls.id };
  }

  it("NFR-7: every primary sale is attributable end to end — each step to its request and who made it, the issuance to its audit row", async () => {
    const { event, zone, classId } = await onSale();
    const ichiba = harness.anonymous();

    // Ichiba, anonymous, begins; Saifu links in the holder's session; the buyer confirms and holds.
    const { token, checkout } = await ichiba.sales.checkout.begin.mutate({
      event,
      zone,
      class: classId,
      placement: { kind: "Unseated" },
    });
    if (checkout.account.state !== "handoff") throw new Error("expected a handoff");
    const saifu = await harness.linkedHolder();
    const { pairingCode } = await saifu.client.sales.checkout.link.mutate({
      handoffToken: checkout.account.handoff.handoffToken,
    });
    await ichiba.sales.checkout.confirmLink.mutate({ token, pairingCode });
    await ichiba.sales.checkout.hold.mutate({ token });
    const payment = await ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS });

    // The provider's webhook reports the payment.
    const providerCheckout = payment.url.split("/").at(-1) as string;
    harness.payments.pay(providerCheckout);
    const webhook = harness.payments.webhook(providerCheckout);
    await fetch(`${harness.address}${PAYMENT_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [harness.payments.webhookSignatureHeader]: webhook.signature,
      },
      body: webhook.rawBody,
    });
    const { sale } = await ichiba.sales.checkout.get.query({ token });
    expect(sale?.status).toBe("issued");

    const trail = await primarySaleTrail(harness.database.store, {
      ticket: sale?.ticket as string,
    });
    if (trail === null) throw new Error("expected the sale's trail");
    const steps = trail.steps.map(({ step, actor, sessionId, holderAccount }) => ({
      step,
      actor,
      sessionId,
      holderAccount,
    }));
    expect(steps).toEqual([
      { step: "begun", actor: "anonymous", sessionId: null, holderAccount: null },
      { step: "linked", actor: "holder", sessionId: saifu.sessionId, holderAccount: saifu.account },
      { step: "link-confirmed", actor: "anonymous", sessionId: null, holderAccount: null },
      { step: "held", actor: "anonymous", sessionId: null, holderAccount: null },
      { step: "payment-started", actor: "anonymous", sessionId: null, holderAccount: null },
      { step: "payment-verified", actor: "payment-provider", sessionId: null, holderAccount: null },
      { step: "issued", actor: "payment-provider", sessionId: null, holderAccount: null },
    ]);
    const byStep = new Map(trail.steps.map((step) => [step.step, step]));
    // Each buyer-facing step is its own request; the verification and the issuance share the webhook's.
    const requests = [
      "begun",
      "linked",
      "link-confirmed",
      "held",
      "payment-started",
      "payment-verified",
    ].map((step) => byStep.get(step as never)?.requestId);
    expect(new Set(requests).size).toBe(requests.length);
    expect(byStep.get("issued")?.requestId).toBe(byStep.get("payment-verified")?.requestId);
    expect(byStep.get("held")?.detail).toMatchObject({ asset: "COPM/2", price: 25_000 });
    expect(byStep.get("payment-started")?.detail).toMatchObject({
      providerCheckout,
      amount: 25_000,
    });

    // The ledger write is the audit log's row, attributed to the buyer's holder session.
    expect(trail.issuance).toEqual({
      operationId: byStep.get("issued")?.detail.operation,
      requestId: byStep.get("payment-verified")?.requestId,
      principalKind: "holder",
      sessionId: saifu.sessionId,
      holderAccount: saifu.account,
      commandKind: "issueTicket",
      outcome: "settled",
      receiptCursor: sale?.cursor,
    });
    // Nothing of the payment's details is recorded: only identifiers, amounts and reasons.
    expect(JSON.stringify(trail)).not.toContain(webhook.signature);
  });

  it("REQ-MP-8: primary checkout is distinguishable in the audit log from any other issuance", async () => {
    const { organiser, event, zone, classId } = await onSale();
    const buyer = await harness.linkedHolder();
    const { token } = await buyer.client.sales.checkout.begin.mutate({
      event,
      zone,
      class: classId,
      placement: { kind: "Unseated" },
    });
    const ichiba = harness.anonymous();
    await ichiba.sales.checkout.hold.mutate({ token });
    const payment = await ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS });
    const providerCheckout = payment.url.split("/").at(-1) as string;
    harness.payments.pay(providerCheckout);
    await harness.sales.payments.reconcile("webhook-request", providerCheckout);

    const guests = await organiser.client.events.classes.define.mutate({
      event,
      name: "Guests",
      description: null,
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: false, cannotTransfer: false },
      quota: null,
      price: null,
    });
    const granted = await organiser.client.events.tickets.issueGranted.mutate({
      event,
      class: guests.id,
      zone,
      placement: { kind: "Unseated" },
      holder: randomBytes(32).toString("hex"),
    });

    const issuances = await harness.database.store.query<{
      operation_id: string;
      primary: boolean;
    }>(
      `SELECT a.operation_id,
              EXISTS (SELECT 1 FROM primary_checkout_audit p WHERE p.operation_id = a.operation_id)
                AS primary
       FROM audit_log a WHERE a.command_kind = 'issueTicket' AND a.outcome = 'settled'
         AND a.receipt_cursor IN ($1, $2)`,
      [(await ichiba.sales.checkout.get.query({ token })).sale?.cursor, granted.cursor],
    );
    expect(issuances.rows.map((row) => row.primary).sort()).toEqual([false, true]);
    expect(await primarySaleTrail(harness.database.store, { ticket: granted.ticket })).toBeNull();

    // A buyer with their own holder session: begun, linked and confirmed by it at once.
    const trail = await primarySaleTrail(harness.database.store, {
      ticket: (await ichiba.sales.checkout.get.query({ token })).sale?.ticket as string,
    });
    expect(trail?.steps.slice(0, 3).map(({ step, actor }) => [step, actor])).toEqual([
      ["begun", "holder"],
      ["linked", "holder"],
      ["link-confirmed", "holder"],
    ]);
  });

  it("a sale that is not issued is attributable too, down to its refund entitlement", async () => {
    const { event, zone, classId } = await onSale();
    const refusing = createSales(
      harness.salesOptions({
        ledger: {
          ...harness.ledger,
          issueTicket: (signer, input) =>
            harness.ledger.issueTicket(signer, { ...input, zone: randomId() as ZoneId }),
        },
      }),
    );
    const buyer = await harness.linkedHolder();
    const { token } = await buyer.client.sales.checkout.begin.mutate({
      event,
      zone,
      class: classId,
      placement: { kind: "Unseated" },
    });
    const ichiba = harness.anonymous();
    await ichiba.sales.checkout.hold.mutate({ token });
    const payment = await ichiba.sales.checkout.pay.mutate({ token, ...RETURN_URLS });
    const providerCheckout = payment.url.split("/").at(-1) as string;
    harness.payments.pay(providerCheckout);
    await refusing.payments.reconcile("webhook-request", providerCheckout);

    const saleId = (
      await harness.database.store.query<{ id: string }>(
        `SELECT s.id FROM primary_sales s JOIN hosted_checkouts k ON k.id = s.hosted_checkout_id
         WHERE k.provider_checkout_id = $1`,
        [providerCheckout],
      )
    ).rows[0]?.id as string;
    const trail = await primarySaleTrail(harness.database.store, { saleId });
    expect(
      trail?.steps.slice(-3).map(({ step, detail }) => [step, detail.reason ?? detail.errorCode]),
    ).toEqual([
      ["payment-verified", undefined],
      ["issuance-rejected", "ERR-UnknownZone"],
      ["refund-entitled", "issuance-rejected"],
    ]);
    expect(trail?.issuance).toMatchObject({ commandKind: "issueTicket", outcome: "rejected" });
  });
});
