import { randomUUID } from "node:crypto";
import type { EventId, TicketId } from "@ticketto/sdk";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import { type CheckoutCause, inTransaction, recordCheckoutStep } from "./audit.js";

/** What recording a cancelled event's refund entitlements found. */
export interface CancellationRefunds {
  /** Entitlements recorded now. */
  readonly recorded: number;
  /** Purchased tickets already entitled, by an earlier run. */
  readonly existing: number;
  /**
   * Purchased tickets of the event in Kippu's copy of the ledger with no primary
   * sale in Kippu's records: no purchaser or face value to refund. Reported, not
   * entitled; none is expected, since only checkout issues purchased tickets.
   */
  readonly unaccounted: readonly string[];
}

export interface CancellationRefundsOptions {
  readonly store: Store;
  readonly ledger: Pick<KippuTicketto, "getEvent" | "getTicket" | "getCancellationHolder">;
  readonly now?: () => Date;
}

interface SaleRow {
  readonly sale_id: string;
  readonly ticket: string;
  readonly hosted_checkout_id: string;
  readonly checkout_id: string;
  readonly purchaser: string;
  readonly amount: string | null;
  readonly asset: string | null;
  readonly hold_price: string | null;
  readonly hold_asset: string | null;
}

/**
 * Cancellation refund entitlements (`T-022-07`; `F-022` plan §5.5, `AC-A5.5`,
 * `REQ-EV-10`, `DEF-12`).
 *
 * For a cancelled event, every purchased ticket Kippu sold — issued, or whose
 * issuance got no verdict but the ledger holds — gets one refund entitlement,
 * at most once: for its face value, owed to its **original purchaser** whatever
 * transfers followed, with the **holder at cancellation** the ledger fixed
 * (`getCancellationHolder`) recorded beside it. A ticket transferred before the
 * cancellation is refunded to its purchaser; its holder then is recorded, and
 * not refunded by Kippu (`DEF-12`). Disbursement is `T-022-08`'s.
 */
export function createCancellationRefunds(options: CancellationRefundsOptions) {
  const { store, ledger, now = () => new Date() } = options;

  return async function recordCancellationRefunds(
    event: string,
    cause: CheckoutCause,
  ): Promise<CancellationRefunds> {
    const found = await ledger.getEvent(event as EventId);
    if (!found.ok) {
      throw new SpecCodeError(found.error.code, found.error.detail);
    }
    if (found.value.status !== "Cancelled") {
      throw new RefusedRequest(
        `refunds for a cancellation are recorded once the event is Cancelled, not ${found.value.status}`,
      );
    }

    const sales = await store.query<SaleRow>(
      `SELECT s.id AS sale_id, s.ticket, s.hosted_checkout_id, h.checkout_id,
              s.holder_account AS purchaser, f.amount, f.asset,
              h.price AS hold_price, h.asset AS hold_asset
       FROM primary_sales s
       JOIN holds h ON h.id = s.hold_id
       LEFT JOIN face_values f ON f.sale_id = s.id
       WHERE h.event = $1 AND s.ticket IS NOT NULL AND s.status IN ('issued', 'failed')
       ORDER BY s.created_at, s.id`,
      [event],
    );

    let recorded = 0;
    let existing = 0;
    for (const sale of sales.rows) {
      const entitled = await store.query("SELECT 1 FROM refund_entitlements WHERE ticket = $1", [
        sale.ticket,
      ]);
      if ((entitled.rowCount ?? 0) > 0) {
        existing += 1;
        continue;
      }
      // A sale with no verdict counts only if the ledger holds its ticket.
      const ticket = await ledger.getTicket(sale.ticket as TicketId);
      if (!ticket.ok) {
        if (ticket.error.code === "ERR-TicketNotFound") continue;
        throw new SpecCodeError(ticket.error.code, ticket.error.detail);
      }
      if (ticket.value.provenance !== "Purchased" || ticket.value.event !== event) continue;
      const holder = await ledger.getCancellationHolder(sale.ticket as TicketId);
      if (!holder.ok) {
        throw new SpecCodeError(holder.error.code, holder.error.detail);
      }
      if (holder.value === null) {
        throw new Error(`the ledger fixes no holder at cancellation for ticket ${sale.ticket}`);
      }
      const amount = Number(sale.amount ?? sale.hold_price);
      const asset = sale.asset ?? sale.hold_asset;
      if (!Number.isSafeInteger(amount) || amount <= 0 || asset === null) {
        throw new Error(`the sale of ticket ${sale.ticket} records no price`);
      }
      const holderAtCancellation = holder.value;

      await inTransaction(store, async (db) => {
        const at = now();
        const inserted = await db.query(
          `INSERT INTO refund_entitlements
             (id, hosted_checkout_id, checkout_id, amount, asset, reason, created_at, ticket,
              purchaser_account, holder_at_cancellation)
           VALUES ($1, $2, $3, $4, $5, 'event-cancelled', $6, $7, $8, $9)
           ON CONFLICT DO NOTHING`,
          [
            randomUUID(),
            sale.hosted_checkout_id,
            sale.checkout_id,
            amount,
            asset,
            at,
            sale.ticket,
            sale.purchaser,
            holderAtCancellation,
          ],
        );
        if (inserted.rowCount === 1) {
          recorded += 1;
          await recordCheckoutStep(db, sale.checkout_id, "refund-entitled", cause, at, {
            reason: "event-cancelled",
            ticket: sale.ticket,
            amount,
            asset,
            purchaser: sale.purchaser,
            holderAtCancellation,
          });
        } else {
          existing += 1;
        }
      });
    }

    const unaccounted = await store.query<{ id: string }>(
      `SELECT t.id FROM derived_tickets t
       WHERE t.event_id = $1 AND t.provenance = 'Purchased'
         AND NOT EXISTS (SELECT 1 FROM primary_sales s WHERE s.ticket = t.id)
       ORDER BY t.id`,
      [event],
    );
    return { recorded, existing, unaccounted: unaccounted.rows.map((row) => row.id) };
  };
}
