import type { Principal } from "../auth/ports.js";
import type { Store } from "../store/store.js";

/** Who caused a checkout step: a principal, the payment provider's webhook, or the background sweep. */
export type CheckoutActor =
  | Principal
  | { readonly kind: "payment-provider" }
  | { readonly kind: "sweep" };

export const PAYMENT_PROVIDER: CheckoutActor = Object.freeze({ kind: "payment-provider" });
export const SWEEP: CheckoutActor = Object.freeze({ kind: "sweep" });

/** A step of a primary checkout, in the order it happens. */
export type CheckoutStep =
  | "begun"
  | "linked"
  | "link-confirmed"
  | "link-discarded"
  | "held"
  | "hold-refused"
  | "payment-started"
  | "checkout-cancelled"
  | "payment-verified"
  | "issued"
  | "issuance-rejected"
  | "issuance-failed"
  | "refund-entitled";

/** What caused a step: the request, and who made it (`NFR-7`). */
export interface CheckoutCause {
  readonly requestId: string;
  readonly actor: CheckoutActor;
}

type Queryable = Pick<Store, "query">;

/**
 * Records one step of a checkout (`T-022-09`; `REQ-MP-8`, `NFR-7`). `detail`
 * names identifiers, amounts and reasons only — never payment or personal
 * details.
 */
export async function recordCheckoutStep(
  db: Queryable,
  checkoutId: string,
  step: CheckoutStep,
  cause: CheckoutCause,
  at: Date,
  detail: Readonly<Record<string, string | number | null>> = {},
): Promise<void> {
  const { actor } = cause;
  const sessionId = "sessionId" in actor ? actor.sessionId : null;
  const holder = actor.kind === "holder" ? actor.account : null;
  await db.query(
    `INSERT INTO checkout_audit
       (checkout_id, step, request_id, actor, session_id, holder_account, detail, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [checkoutId, step, cause.requestId, actor.kind, sessionId, holder, JSON.stringify(detail), at],
  );
}

/** One recorded step. */
export interface CheckoutAuditStep {
  readonly step: CheckoutStep;
  readonly requestId: string;
  readonly actor: CheckoutActor["kind"];
  readonly sessionId: string | null;
  readonly holderAccount: string | null;
  readonly detail: Readonly<Record<string, string | number | null>>;
  readonly recordedAt: Date;
}

/** The relayed issuance of a primary sale, as the audit log records it. */
export interface PrimaryIssuanceAudit {
  readonly operationId: string;
  readonly requestId: string;
  readonly principalKind: string;
  readonly sessionId: string | null;
  readonly holderAccount: string | null;
  readonly commandKind: string;
  readonly outcome: string;
  readonly receiptCursor: string | null;
}

/** A primary sale, end to end. */
export interface PrimarySaleTrail {
  readonly checkoutId: string;
  readonly saleId: string;
  readonly steps: readonly CheckoutAuditStep[];
  /** `null` when nothing was signed. */
  readonly issuance: PrimaryIssuanceAudit | null;
}

/**
 * The trail of the primary sale that issued `ticket`, or of `saleId`: every step
 * of its checkout, and the audit log's row of its issuance (`T-022-09`). `null`
 * when no primary sale matches — a granted ticket, say.
 */
export async function primarySaleTrail(
  db: Queryable,
  by: { readonly ticket: string } | { readonly saleId: string },
): Promise<PrimarySaleTrail | null> {
  const sale = (
    await db.query<{ id: string; checkout_id: string; operation_id: string | null }>(
      `SELECT s.id, h.checkout_id, s.operation_id FROM primary_sales s
       JOIN holds h ON h.id = s.hold_id
       WHERE ${"ticket" in by ? "s.ticket = $1" : "s.id = $1"}`,
      ["ticket" in by ? by.ticket : by.saleId],
    )
  ).rows[0];
  if (sale === undefined) return null;
  const steps = await db.query<{
    step: CheckoutStep;
    request_id: string;
    actor: CheckoutActor["kind"];
    session_id: string | null;
    holder_account: string | null;
    detail: Record<string, string | number | null>;
    recorded_at: Date;
  }>(
    `SELECT step, request_id, actor, session_id, holder_account, detail, recorded_at
     FROM checkout_audit WHERE checkout_id = $1 ORDER BY id`,
    [sale.checkout_id],
  );
  const issuance = (
    await db.query<{
      operation_id: string;
      request_id: string;
      principal_kind: string;
      session_id: string | null;
      holder_account: string | null;
      command_kind: string;
      outcome: string;
      receipt_cursor: string | null;
    }>(
      `SELECT operation_id, request_id, principal_kind, session_id, holder_account, command_kind,
              outcome, receipt_cursor
       FROM primary_checkout_audit WHERE sale_id = $1`,
      [sale.id],
    )
  ).rows[0];
  return {
    checkoutId: sale.checkout_id,
    saleId: sale.id,
    steps: steps.rows.map((row) => ({
      step: row.step,
      requestId: row.request_id,
      actor: row.actor,
      sessionId: row.session_id,
      holderAccount: row.holder_account,
      detail: row.detail,
      recordedAt: row.recorded_at,
    })),
    issuance:
      issuance === undefined
        ? null
        : {
            operationId: issuance.operation_id,
            requestId: issuance.request_id,
            principalKind: issuance.principal_kind,
            sessionId: issuance.session_id,
            holderAccount: issuance.holder_account,
            commandKind: issuance.command_kind,
            outcome: issuance.outcome,
            receiptCursor: issuance.receipt_cursor,
          },
  };
}

/** Runs `work` in one transaction of the store: a change and its recorded step land together. */
export async function inTransaction<T>(
  store: Store,
  work: (db: Queryable) => Promise<T>,
): Promise<T> {
  const client = await store.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
