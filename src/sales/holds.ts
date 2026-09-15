import { randomUUID } from "node:crypto";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import type { SeatAllocation } from "../events/seats.js";
import { positionOf } from "../events/zones.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import {
  allocationCounts,
  capacityHasRoom,
  lockAllocation,
  quotaHasRoom,
  saleTerms,
} from "./allocation.js";
import { recordCheckoutStep } from "./audit.js";
import { eventOnSale } from "./on-sale.js";
import { CheckoutError, type HoldRefusal, type SalesRequest } from "./ports.js";

/** How long a hold lives once placed (`F-022` plan §5.2). */
export const HOLD_LIFETIME_MS = 10 * 60 * 1000;

/** How much longer a hold lives, once, when payment starts (`F-022` plan §5.2). */
export const HOLD_EXTENSION_MS = 5 * 60 * 1000;

/** How often outstanding holds past their lifetime are recorded as lapsed. */
export const LAPSE_SWEEP_INTERVAL_MS = 15 * 1000;

/** What a hold reserves: the issuance of one ticket for one checkout. */
export interface HoldTarget {
  readonly checkoutId: string;
  readonly event: string;
  readonly zone: string;
  readonly classId: string;
  /** The seat's canonical designation in a seated zone; `null` for general admission. */
  readonly position: string | null;
}

/**
 * Issuance holds (`T-022-03`; `REQ-HD-1`–`REQ-HD-3`, `F-022` plan §5.1 step 3, §5.2).
 *
 * The later steps of checkout — authorising payment, issuing, confirming — use
 * `extend` and `release`; organiser actions will use the accounting (`REQ-HD-4`).
 */
export interface Holds {
  /**
   * Places the checkout's hold, or says why it is refused. Answers `null` when the
   * checkout's hold is outstanding, whether placed now or before; throws
   * `CheckoutError("hold-ended")` when it has lapsed or been released.
   */
  place(request: SalesRequest, target: HoldTarget): Promise<HoldRefusal | null>;
  /**
   * Extends an outstanding, unexpired hold's lifetime by `HOLD_EXTENSION_MS`, once,
   * when payment starts. Answers whether it did.
   */
  extend(checkoutId: string): Promise<boolean>;
  /**
   * Releases an outstanding hold, so it no longer counts (`REQ-HD-1`). One already
   * past its lifetime is recorded as lapsed. Answers whether a hold was outstanding.
   */
  release(checkoutId: string): Promise<boolean>;
  /** Records every outstanding hold past its lifetime as lapsed. Answers how many. */
  lapseExpired(): Promise<number>;
}

export interface HoldsOptions {
  readonly store: Store;
  readonly ledger: Pick<KippuTicketto, "getEvent">;
  /** `F-021`'s seated double-allocation pre-check (`T-021-06`): every allocation of a seat locks and checks it. */
  readonly seats: Pick<SeatAllocation, "lock" | "assertFree">;
  readonly now?: () => Date;
}

export function createHolds(options: HoldsOptions): Holds {
  const { store, ledger, seats, now = () => new Date() } = options;

  return {
    async place(request, target) {
      const client = await store.connect();
      try {
        await client.query("BEGIN");
        // The seat, then the event's allocations, in the one order every allocation of an
        // event's issuance locks them — holds and granted issuances alike (REQ-HD-3).
        const seat = target.position === null ? null : positionOf(target.position);
        await lockAllocation(client, seats, target);
        const at = now();
        // Expired holds stop counting; what stands against this hold is counted under the locks.
        const counts = await allocationCounts(client, target, at);

        const existing = await client.query<{ status: string }>(
          "SELECT status FROM holds WHERE checkout_id = $1",
          [target.checkoutId],
        );
        const status = existing.rows[0]?.status;
        if (status !== undefined && status !== "outstanding") {
          throw new CheckoutError("hold-ended", `the checkout's hold is ${status}`);
        }
        if (status === "outstanding") {
          await client.query("COMMIT");
          return null;
        }

        const event = await eventOnSale(ledger, target.event);
        // The sale terms in force now are the hold's: a later price change affects only
        // holds placed afterwards, and the asset is fixed from this hold on (F-021 "Prices").
        const terms = await saleTerms(client, target.event, target.classId);
        if (terms === null) {
          throw new RefusedRequest(
            "the event has no sale asset, or the class no price: nothing of it can be held yet",
            "PRECONDITION_FAILED",
          );
        }
        let refusal: HoldRefusal | null = null;
        if (seat !== null) {
          // The seat is free only if the ledger, Kippu's granted issuances and its
          // outstanding holds all agree (REQ-HD-3, AC-B5.2).
          try {
            await seats.assertFree(client, target.event, target.zone, seat);
            if (counts.seatHeld) refusal = "seat-taken";
          } catch (error) {
            if (!(error instanceof SpecCodeError && error.code === "ERR-TicketIdExists"))
              throw error;
            refusal = "seat-taken";
          }
        }
        if (refusal === null && !capacityHasRoom(event, counts)) {
          refusal = "sold-out";
        }
        if (refusal === null && !quotaHasRoom(counts)) {
          refusal = "class-sold-out";
        }
        const cause = { requestId: request.requestId, actor: request.principal };
        if (refusal !== null) {
          await recordCheckoutStep(client, target.checkoutId, "hold-refused", cause, at, {
            reason: refusal,
          });
          await client.query("COMMIT");
          return refusal;
        }
        const holdId = randomUUID();

        await client.query(
          `INSERT INTO holds
             (id, checkout_id, event, zone, class_id, position, expires_at, created_request_id,
              created_at, asset, price)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            holdId,
            target.checkoutId,
            target.event,
            target.zone,
            target.classId,
            target.position,
            new Date(at.getTime() + HOLD_LIFETIME_MS),
            request.requestId,
            at,
            terms.asset,
            terms.price,
          ],
        );
        await recordCheckoutStep(client, target.checkoutId, "held", cause, at, {
          hold: holdId,
          asset: terms.asset,
          price: terms.price,
        });
        await client.query("COMMIT");
        return null;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async extend(checkoutId) {
      const at = now();
      const updated = await store.query(
        `UPDATE holds SET expires_at = expires_at + make_interval(secs => $2), extended_at = $3
         WHERE checkout_id = $1 AND status = 'outstanding' AND extended_at IS NULL
           AND expires_at > $3`,
        [checkoutId, HOLD_EXTENSION_MS / 1000, at],
      );
      return updated.rowCount === 1;
    },

    async release(checkoutId) {
      const at = now();
      const updated = await store.query(
        `UPDATE holds
         SET status = CASE WHEN expires_at <= $2 THEN 'lapsed' ELSE 'released' END,
             ended_at = LEAST(expires_at, $2)
         WHERE checkout_id = $1 AND status = 'outstanding'`,
        [checkoutId, at],
      );
      return updated.rowCount === 1;
    },

    async lapseExpired() {
      const updated = await store.query(
        `UPDATE holds SET status = 'lapsed', ended_at = expires_at
         WHERE status = 'outstanding' AND expires_at <= $1`,
        [now()],
      );
      return updated.rowCount ?? 0;
    },
  };
}

/** A background task recording lapsed holds every `LAPSE_SWEEP_INTERVAL_MS`. */
export interface LapseSweeper {
  start(): void;
  stop(): Promise<void>;
}

export function lapseSweeper(
  holds: { lapseExpired(): Promise<unknown> },
  onError: (error: unknown) => void = (error) => console.error(error),
  intervalMs: number = LAPSE_SWEEP_INTERVAL_MS,
): LapseSweeper {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        running = running.then(() => holds.lapseExpired().then(() => {}, onError));
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
