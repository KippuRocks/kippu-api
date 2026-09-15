import { randomBytes, randomUUID } from "node:crypto";
import type {
  AccountId,
  ClassId,
  Discriminator,
  EventId,
  Placement,
  Receipt,
  Result,
  ZoneId,
} from "@ticketto/sdk";
import { commandOfSigningPayload } from "../audit/relay.js";
import type { HolderPrincipal } from "../auth/ports.js";
import { hashSecret } from "../auth/service.js";
import type { OrganiserAuthority } from "../authority/authority.js";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import type { Classes } from "../classes/classes.js";
import { DISCRIMINATOR_BYTES } from "../events/issuance.js";
import type { SeatAllocation } from "../events/seats.js";
import { positionOf } from "../events/zones.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import {
  type AllocationTarget,
  allocationCounts,
  capacityHasRoom,
  lockAllocation,
  quotaHasRoom,
} from "./allocation.js";
import {
  type CheckoutActor,
  type CheckoutCause,
  PAYMENT_PROVIDER,
  recordCheckoutStep,
  SWEEP,
} from "./audit.js";
import { HOLD_EXTENSION_MS } from "./holds.js";
import type { HostedCheckout, PaymentProvider } from "./payments/ports.js";
import {
  CheckoutError,
  type CheckoutPayment,
  type CheckoutRefund,
  type PayCheckoutInput,
  type SalesRequest,
} from "./ports.js";

/** Where kippu-api receives payment providers' webhooks: an operational route, outside `/v0`. */
export const PAYMENT_WEBHOOK_PATH = "/webhooks/payments";

export interface PaymentsOptions {
  readonly store: Store;
  readonly ledger: Pick<KippuTicketto, "getEvent" | "issueTicket">;
  readonly authority: Pick<OrganiserAuthority, "relay">;
  readonly classes: Pick<Classes, "find">;
  readonly seats: Pick<SeatAllocation, "lock" | "assertFree">;
  readonly provider: PaymentProvider;
  /** The absolute URL of `PAYMENT_WEBHOOK_PATH` on kippu-api's public origin. */
  readonly webhookUrl: string;
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
  /** Receives failures of work a webhook or a sweep started, which no caller awaits. */
  readonly onError?: (error: unknown) => void;
}

/** Paying for holds, and what a verified payment leads to (`T-022-04`). */
export interface Payments {
  pay(request: SalesRequest, input: PayCheckoutInput): Promise<CheckoutPayment>;
  cancel(request: SalesRequest, token: string): Promise<void>;
  paymentWebhook(
    requestId: string,
    rawBody: string,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<boolean>;
  /**
   * Retrieves a hosted checkout from the provider and acts on what it says: a
   * payment for the hold's price issues the ticket, or records a refund
   * entitlement when it cannot. Idempotent.
   */
  reconcile(requestId: string, providerCheckoutId: string, actor?: CheckoutActor): Promise<void>;
  /**
   * Records lapsed holds, then cancels the open hosted checkouts of holds that
   * ended; a payment that landed first is reconciled instead (plan §5.1 step 6).
   */
  sweep(requestId: string): Promise<void>;
}

interface HoldRow {
  readonly hold_id: string;
  readonly checkout_id: string;
  readonly event: string;
  readonly zone: string;
  readonly class_id: string;
  readonly position: string | null;
  readonly status: string;
  readonly expires_at: Date;
  readonly extended_at: Date | null;
  readonly price: string | null;
  readonly asset: string | null;
  readonly holder_account: string | null;
  readonly linked_session_id: string | null;
  readonly link_confirmed_at: Date | null;
}

interface HostedRow {
  readonly id: string;
  readonly hold_id: string;
  readonly provider_checkout_id: string;
  readonly url: string;
  readonly amount: string;
  readonly asset: string;
  readonly status: CheckoutPayment["status"];
  readonly expires_at: Date;
}

const HOLD_COLUMNS = `h.id AS hold_id, h.checkout_id, h.event, h.zone, h.class_id, h.position,
  h.status, h.expires_at, h.extended_at, h.price, h.asset, c.holder_account, c.linked_session_id,
  c.link_confirmed_at`;

const HOSTED_COLUMNS = "id, hold_id, provider_checkout_id, url, amount, asset, status, expires_at";

const paymentOf = (row: HostedRow): CheckoutPayment => ({
  status: row.status,
  url: row.url,
  amount: Number(row.amount),
  asset: row.asset,
  expiresAt: row.expires_at.toISOString(),
});

type Queryable = Pick<Store, "query">;

/**
 * Paid checkout (`T-022-04`; `F-022` plan §5.1 steps 4–7, §5.4): hold → hosted
 * checkout → verified payment → issue → confirm.
 *
 * - **Pay.** A hosted checkout is created for an outstanding hold whose link is
 *   confirmed, at the price the hold recorded, expiring with the hold — which
 *   takes its single 5-minute extension then. It is single-use; a cancelled or
 *   expired one is replaced while the hold lives.
 * - **Paid.** A webhook only prompts a retrieval: a payment is trusted once the
 *   provider reports the checkout `paid`, for the hold, at the hold's amount and
 *   asset. Under the allocation locks the hold becomes `issuing` — it no longer
 *   lapses — and the ticket is issued through the organiser's authority, with
 *   `Purchased` provenance, the class's policy, no restrictions (`REQ-TK-3`) and
 *   no price (`AC-B4.2`). Settled, the hold is `confirmed`.
 * - **Not paid.** A lapsed or abandoned hold's hosted checkout is cancelled, and
 *   the hold released: no ticket, no charge (`AC-B4.3`).
 * - **Paid, not issued.** The ledger refuses, or the payment lands after the hold
 *   ended and the place is gone: a refund entitlement, never a ticket without a
 *   hold. A payment that lands after the hold lapsed, while the place is still
 *   free, takes the hold back and is issued.
 * - **Face value.** Confirming a hold records the ticket's face value — the
 *   price and asset its hold recorded — in the same transaction (`T-022-06`).
 * - A submission with no verdict leaves the sale `failed` and the hold counting,
 *   since the ticket may exist; it records no refund.
 */
export function createPayments(options: PaymentsOptions): Payments {
  const { store, ledger, authority, classes, seats, provider, webhookUrl } = options;
  const now = options.now ?? (() => new Date());
  const random = options.randomBytes ?? ((length: number) => randomBytes(length));
  const onError = options.onError ?? ((error: unknown) => console.error(error));

  const holdByToken = async (db: Queryable, token: string, lock: boolean) => {
    const row = (
      await db.query<HoldRow>(
        `SELECT ${HOLD_COLUMNS} FROM checkout_sessions c JOIN holds h ON h.checkout_id = c.id
         WHERE c.token_hash = $1 ${lock ? "FOR UPDATE OF h" : ""}`,
        [hashSecret(token)],
      )
    ).rows[0];
    if (row !== undefined) return row;
    const checkout = await db.query("SELECT 1 FROM checkout_sessions WHERE token_hash = $1", [
      hashSecret(token),
    ]);
    if ((checkout.rowCount ?? 0) === 0) {
      throw new CheckoutError("unknown-checkout", "no checkout has this token");
    }
    throw new CheckoutError("hold-required", "place the checkout's hold before paying");
  };

  const openHosted = async (db: Queryable, holdId: string) =>
    (
      await db.query<HostedRow>(
        `SELECT ${HOSTED_COLUMNS} FROM hosted_checkouts WHERE hold_id = $1 AND status = 'open'`,
        [holdId],
      )
    ).rows[0];

  const recordStatus = (db: Queryable, id: string, remote: HostedCheckout) =>
    db.query("UPDATE hosted_checkouts SET status = $2, updated_at = $3 WHERE id = $1", [
      id,
      remote.status,
      now(),
    ]);

  const releaseHold = (db: Queryable, holdId: string) =>
    db.query(
      `UPDATE holds
       SET status = CASE WHEN expires_at <= $2 THEN 'lapsed' ELSE 'released' END,
           ended_at = LEAST(expires_at, $2)
       WHERE id = $1 AND status = 'outstanding'`,
      [holdId, now()],
    );

  const entitle = async (
    db: Queryable,
    cause: CheckoutCause,
    hosted: HostedRow,
    checkoutId: string,
    amount: number,
    asset: string,
    reason: CheckoutRefund["reason"],
  ) => {
    const at = now();
    const inserted = await db.query(
      `INSERT INTO refund_entitlements
         (id, hosted_checkout_id, checkout_id, amount, asset, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (hosted_checkout_id) DO NOTHING`,
      [randomUUID(), hosted.id, checkoutId, amount, asset, reason, at],
    );
    if (inserted.rowCount === 1) {
      await recordCheckoutStep(db, checkoutId, "refund-entitled", cause, at, {
        reason,
        amount,
        asset,
        providerCheckout: hosted.provider_checkout_id,
      });
    }
  };

  /** Under a transaction: takes the verified payment's place, or records why it cannot. */
  const takePlace = async (
    cause: CheckoutCause,
    hosted: HostedRow,
    remote: HostedCheckout,
  ): Promise<{ saleId: string; hold: HoldRow } | null> => {
    const client = await store.connect();
    try {
      await client.query("BEGIN");
      const hold = (
        await client.query<HoldRow>(
          `SELECT ${HOLD_COLUMNS} FROM holds h JOIN checkout_sessions c ON c.id = h.checkout_id
           WHERE h.id = $1`,
          [hosted.hold_id],
        )
      ).rows[0] as HoldRow;
      const target: AllocationTarget = {
        event: hold.event,
        zone: hold.zone,
        classId: hold.class_id,
        position: hold.position,
      };
      await lockAllocation(client, seats, target);
      await recordStatus(client, hosted.id, remote);
      const handled = await client.query(
        `SELECT 1 FROM primary_sales WHERE hosted_checkout_id = $1
         UNION ALL SELECT 1 FROM refund_entitlements WHERE hosted_checkout_id = $1`,
        [hosted.id],
      );
      if ((handled.rowCount ?? 0) > 0) {
        await client.query("COMMIT");
        return null;
      }
      await recordCheckoutStep(client, hold.checkout_id, "payment-verified", cause, now(), {
        providerCheckout: hosted.provider_checkout_id,
        amount: remote.amount,
        asset: remote.asset,
      });

      // Trusted only for the hold's amount and asset (plan §5.4).
      if (remote.amount !== Number(hosted.amount) || remote.asset !== hosted.asset) {
        await entitle(
          client,
          cause,
          hosted,
          hold.checkout_id,
          remote.amount,
          remote.asset,
          "amount-mismatch",
        );
        await releaseHold(client, hold.hold_id);
        await client.query("COMMIT");
        return null;
      }

      // Lapses are recorded first; then the hold is re-read under the locks.
      const counts = await allocationCounts(client, target, now());
      const current = (
        await client.query<{ status: string }>("SELECT status FROM holds WHERE id = $1", [
          hold.hold_id,
        ])
      ).rows[0]?.status;

      let placed = current === "outstanding";
      if (current === "lapsed" || current === "released") {
        // The payment landed after the hold ended: issued only if the place is still free.
        const found = await ledger.getEvent(hold.event as EventId);
        let free = found.ok && found.value.status === "Active";
        if (free && found.ok) {
          free = capacityHasRoom(found.value, counts) && quotaHasRoom(counts) && !counts.seatHeld;
        }
        if (free && hold.position !== null) {
          try {
            await seats.assertFree(client, hold.event, hold.zone, positionOf(hold.position));
          } catch (error) {
            if (!(error instanceof SpecCodeError && error.code === "ERR-TicketIdExists")) {
              throw error;
            }
            free = false;
          }
        }
        placed = free;
      }
      if (!placed) {
        // Gone, or the hold is already another payment's.
        await entitle(
          client,
          cause,
          hosted,
          hold.checkout_id,
          remote.amount,
          remote.asset,
          "place-gone",
        );
        await client.query("COMMIT");
        return null;
      }

      await client.query("UPDATE holds SET status = 'issuing', ended_at = NULL WHERE id = $1", [
        hold.hold_id,
      ]);
      const saleId = randomUUID();
      await client.query(
        `INSERT INTO primary_sales (id, hosted_checkout_id, hold_id, holder_account, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [saleId, hosted.id, hold.hold_id, hold.holder_account, now()],
      );
      await client.query("COMMIT");
      return { saleId, hold };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  /** Issues the paid hold's ticket through the organiser's authority, and records the outcome. */
  const issue = async (
    cause: CheckoutCause,
    hosted: HostedRow,
    saleId: string,
    hold: HoldRow,
  ): Promise<void> => {
    const complete = async (
      status: "issued" | "rejected" | "failed",
      fields: { ticket?: string; cursor?: string; errorCode?: string } = {},
    ) => {
      const client = await store.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE primary_sales
           SET status = $2, ticket = COALESCE($3, ticket), receipt_cursor = $4, error_code = $5,
               completed_at = $6
           WHERE id = $1`,
          [
            saleId,
            status,
            fields.ticket ?? null,
            fields.cursor ?? null,
            fields.errorCode ?? null,
            now(),
          ],
        );
        if (status === "issued") {
          await client.query(
            "UPDATE holds SET status = 'confirmed', confirmed_at = $2 WHERE id = $1",
            [hold.hold_id, now()],
          );
          // The ticket's face value, for its life: the price its hold recorded (T-022-06).
          await client.query(
            `INSERT INTO face_values (ticket, event, class_id, sale_id, amount, asset, recorded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [fields.ticket, hold.event, hold.class_id, saleId, hold.price, hold.asset, now()],
          );
          await recordCheckoutStep(client, hold.checkout_id, "issued", cause, now(), {
            sale: saleId,
            ticket: fields.ticket ?? null,
            operation: operationId,
            cursor: fields.cursor ?? null,
          });
        } else if (status === "rejected") {
          // Not issued: the place is given back, whatever the hold's lifetime said.
          await client.query(
            `UPDATE holds SET status = 'released', ended_at = $2
             WHERE id = $1 AND status = 'issuing'`,
            [hold.hold_id, now()],
          );
          await recordCheckoutStep(client, hold.checkout_id, "issuance-rejected", cause, now(), {
            sale: saleId,
            operation: operationId,
            errorCode: fields.errorCode ?? null,
          });
          await entitle(
            client,
            cause,
            hosted,
            hold.checkout_id,
            Number(hosted.amount),
            hosted.asset,
            "issuance-rejected",
          );
        } else {
          await recordCheckoutStep(client, hold.checkout_id, "issuance-failed", cause, now(), {
            sale: saleId,
            operation: operationId,
          });
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };

    // The operation the issuance is signed as: its audit_log row is the sale's (T-022-09).
    let operationId: string | null = null;
    let issued: Awaited<ReturnType<KippuTicketto["issueTicket"]>>;
    try {
      const organiser = (
        await store.query<{ organiser_id: string }>(
          "SELECT organiser_id FROM organiser_events WHERE event = $1",
          [hold.event],
        )
      ).rows[0];
      const ticketClass = await classes.find(hold.event, hold.class_id);
      if (organiser === undefined || ticketClass === null) {
        throw new RefusedRequest("the event's organiser or the class is unknown to Kippu");
      }
      const placement: Placement =
        hold.position === null
          ? {
              kind: "Unseated",
              discriminator: Buffer.from(random(DISCRIMINATOR_BYTES)).toString(
                "hex",
              ) as Discriminator,
            }
          : { kind: "Seated", position: positionOf(hold.position) };
      // The buyer's checkout caused the write: it is attributed to their holder session (NFR-7).
      const principal: HolderPrincipal = {
        kind: "holder",
        account: hold.holder_account as string,
        sessionId: hold.linked_session_id as string,
      };
      const { requestId } = cause;
      issued = await authority.relay(
        organiser.organiser_id,
        { requestId, principal },
        (audited) => {
          const signer: typeof audited = {
            account: audited.account,
            async sign(payload) {
              const signature = await audited.sign(payload);
              operationId = commandOfSigningPayload(payload)?.operationId ?? null;
              return signature;
            },
          };
          return ledger.issueTicket(signer, {
            event: hold.event as EventId,
            zone: hold.zone as ZoneId,
            placement,
            class: hold.class_id as ClassId,
            provenance: "Purchased",
            policy: ticketClass.policy,
            // A purchased ticket carries no restriction (REQ-TK-3), and no price (AC-B4.2).
            restrictions: { cannotResale: false, cannotTransfer: false },
            holder: hold.holder_account as AccountId,
            metadata: null,
          });
        },
      );
    } catch (error) {
      // Nothing was signed: the ticket does not exist.
      await complete("rejected");
      onError(error);
      return;
    }
    await store.query("UPDATE primary_sales SET ticket = $2 WHERE id = $1", [saleId, issued.id]);
    const recordOperation = () =>
      operationId === null
        ? Promise.resolve()
        : store.query("UPDATE primary_sales SET operation_id = $2 WHERE id = $1", [
            saleId,
            operationId,
          ]);
    let outcome: Result<Receipt>;
    try {
      outcome = await issued.submission;
    } catch (error) {
      await recordOperation();
      await complete("failed");
      onError(error);
      return;
    }
    await recordOperation();
    if (outcome.ok) {
      await complete("issued", { ticket: issued.id, cursor: outcome.value.cursor });
    } else {
      await complete("rejected", { errorCode: outcome.error.code });
    }
  };

  const reconcile = async (
    requestId: string,
    providerCheckoutId: string,
    actor: CheckoutActor = PAYMENT_PROVIDER,
  ): Promise<void> => {
    const cause: CheckoutCause = { requestId, actor };
    const hosted = (
      await store.query<HostedRow>(
        `SELECT ${HOSTED_COLUMNS} FROM hosted_checkouts WHERE provider_checkout_id = $1`,
        [providerCheckoutId],
      )
    ).rows[0];
    if (hosted === undefined) return;
    const remote = await provider.retrieve(providerCheckoutId);
    if (remote.holdId !== hosted.hold_id) return;
    if (remote.status !== "paid") {
      await recordStatus(store, hosted.id, remote);
      return;
    }
    const taken = await takePlace(cause, hosted, remote);
    if (taken !== null) {
      await issue(cause, hosted, taken.saleId, taken.hold);
    }
  };

  /** Cancels a hold's open hosted checkout. Answers whether it turned out paid. */
  const cancelHosted = async (db: Queryable, hosted: HostedRow): Promise<boolean> => {
    const remote = await provider.cancel(hosted.provider_checkout_id);
    if (remote.status === "paid") return true;
    await recordStatus(db, hosted.id, remote);
    return false;
  };

  return {
    async pay(request, input) {
      const client = await store.connect();
      let paidFirst: string | null = null;
      try {
        await client.query("BEGIN");
        const hold = await holdByToken(client, input.token, true);
        if (hold.link_confirmed_at === null || hold.holder_account === null) {
          throw new CheckoutError("link-unconfirmed", "the checkout's link is not confirmed");
        }
        if (hold.status === "issuing" || hold.status === "confirmed") {
          throw new CheckoutError("already-paid", "the checkout's hold is already paid for");
        }
        const at = now();
        if (hold.status !== "outstanding" || hold.expires_at <= at) {
          throw new CheckoutError("hold-ended", "the checkout's hold lapsed or was released");
        }
        if (hold.price === null || hold.asset === null) {
          throw new RefusedRequest("the hold has no price: it was placed before prices existed");
        }

        const open = await openHosted(client, hold.hold_id);
        if (open !== undefined) {
          const remote = await provider.retrieve(open.provider_checkout_id);
          if (remote.status === "open") {
            await client.query("COMMIT");
            return paymentOf(open);
          }
          await recordStatus(client, open.id, remote);
          if (remote.status === "paid") {
            paidFirst = open.provider_checkout_id;
            await client.query("COMMIT");
            throw new CheckoutError("already-paid", "the checkout's hold is already paid for");
          }
        }

        // The hold's single extension is taken when its hosted checkout is created (plan §5.4).
        let expiresAt = hold.expires_at;
        if (hold.extended_at === null) {
          expiresAt = new Date(hold.expires_at.getTime() + HOLD_EXTENSION_MS);
          await client.query("UPDATE holds SET expires_at = $2, extended_at = $3 WHERE id = $1", [
            hold.hold_id,
            expiresAt,
            at,
          ]);
        }
        const ticketClass = await classes.find(hold.event, hold.class_id);
        const created = await provider.createCheckout({
          holdId: hold.hold_id,
          description: ticketClass?.name ?? "Ticket",
          amount: Number(hold.price),
          asset: hold.asset,
          expiresAt,
          successUrl: input.successUrl,
          cancelUrl: input.cancelUrl,
          webhookUrl,
        });
        const row = (
          await client.query<HostedRow>(
            `INSERT INTO hosted_checkouts
               (id, hold_id, provider_checkout_id, url, amount, asset, status, expires_at,
                created_request_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $9)
             RETURNING ${HOSTED_COLUMNS}`,
            [
              randomUUID(),
              hold.hold_id,
              created.id,
              created.url,
              Number(hold.price),
              hold.asset,
              expiresAt,
              request.requestId,
              at,
            ],
          )
        ).rows[0] as HostedRow;
        await recordCheckoutStep(
          client,
          hold.checkout_id,
          "payment-started",
          { requestId: request.requestId, actor: request.principal },
          at,
          {
            providerCheckout: created.id,
            amount: Number(hold.price),
            asset: hold.asset,
            expiresAt: expiresAt.toISOString(),
          },
        );
        await client.query("COMMIT");
        return paymentOf(row);
      } catch (error) {
        if (paidFirst === null) await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
        if (paidFirst !== null) {
          await reconcile(request.requestId, paidFirst, request.principal).catch(onError);
        }
      }
    },

    async cancel(request, token) {
      const client = await store.connect();
      const paid: string[] = [];
      try {
        await client.query("BEGIN");
        const hold = await holdByToken(client, token, true);
        if (hold.status !== "outstanding") {
          await client.query("COMMIT");
          return;
        }
        const open = await openHosted(client, hold.hold_id);
        if (open !== undefined && (await cancelHosted(client, open))) {
          paid.push(open.provider_checkout_id);
        } else {
          await releaseHold(client, hold.hold_id);
          await recordCheckoutStep(
            client,
            hold.checkout_id,
            "checkout-cancelled",
            { requestId: request.requestId, actor: request.principal },
            now(),
            { providerCheckout: open?.provider_checkout_id ?? null },
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      for (const id of paid) await reconcile(request.requestId, id, request.principal);
    },

    async paymentWebhook(requestId, rawBody, headers) {
      const header = headers[provider.webhookSignatureHeader];
      const signature = Array.isArray(header) ? header[0] : header;
      const verified = provider.verifyWebhook(rawBody, signature);
      if (verified === null) return false;
      const rows = await store.query<{ provider_checkout_id: string }>(
        `SELECT provider_checkout_id FROM hosted_checkouts
         WHERE provider_checkout_id = ANY($1::text[]) OR hold_id::text = ANY($2::text[])`,
        [verified.checkoutIds, verified.holdIds],
      );
      for (const row of rows.rows) {
        await reconcile(requestId, row.provider_checkout_id);
      }
      return true;
    },

    reconcile,

    async sweep(requestId) {
      await store.query(
        `UPDATE holds SET status = 'lapsed', ended_at = expires_at
         WHERE status = 'outstanding' AND expires_at <= $1`,
        [now()],
      );
      const ended = await store.query<HostedRow>(
        `SELECT ${HOSTED_COLUMNS.split(", ")
          .map((column) => `k.${column}`)
          .join(", ")}
         FROM hosted_checkouts k JOIN holds h ON h.id = k.hold_id
         WHERE k.status = 'open' AND h.status IN ('lapsed', 'released')`,
      );
      for (const hosted of ended.rows) {
        try {
          if (await cancelHosted(store, hosted)) {
            await reconcile(requestId, hosted.provider_checkout_id, SWEEP);
          }
        } catch (error) {
          onError(error);
        }
      }
    },
  };
}
