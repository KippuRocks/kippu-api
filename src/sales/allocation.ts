import type { Event } from "@ticketto/sdk";
import type { SaleAsset } from "../events/ports.js";
import type { Queryable, SeatAllocation } from "../events/seats.js";
import { positionOf } from "../events/zones.js";

/**
 * Accounting shared by every allocation of an event's issuance — a checkout's
 * hold (`T-022-03`) and a granted issuance (`T-021-05`, `T-021-13`) — so each
 * counts the others (`REQ-HD-3`, `REQ-HD-4`).
 *
 * Lock order, always, inside the transaction that records the allocation:
 * 1. the seat, for a seated allocation (`SeatAllocation.lock`, `T-021-06`);
 * 2. the event's allocations ({@link lockAllocation} takes both).
 * Counting and recording then happen under those locks.
 */

/** The first key of the per-event allocation lock: "hold". */
export const ALLOCATION_LOCK_NAMESPACE = 0x686f6c64;

/** What one allocation reserves. */
export interface AllocationTarget {
  readonly event: string;
  readonly zone: string;
  readonly classId: string;
  /** The seat's canonical designation, in NFC, in a seated zone; `null` otherwise. */
  readonly position: string | null;
}

/** Takes the allocation's locks in the one order every allocation uses. */
export async function lockAllocation(
  db: Queryable,
  seats: Pick<SeatAllocation, "lock">,
  target: AllocationTarget,
): Promise<void> {
  if (target.position !== null) {
    await seats.lock(db, target.event, target.zone, positionOf(target.position));
  }
  await lockEventAllocations(db, target.event);
}

/**
 * Takes only the event's allocation lock: for a change to the event's sale terms
 * that must see every hold (`T-021-14`). It locks no seat, so it takes the second
 * lock of the order and nothing after it is out of order.
 */
export async function lockEventAllocations(db: Queryable, event: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
    ALLOCATION_LOCK_NAMESPACE,
    event,
  ]);
}

/** The terms a hold is placed on (`F-021` plan, "Prices"). */
export interface SaleTerms {
  readonly asset: SaleAsset;
  /** A positive integer in the asset's minor units. */
  readonly price: number;
}

/**
 * The event's sale asset and the class's current price — what a hold placed now
 * records — or `null` when the event has no sale asset or the class no price.
 * Read under the event's allocation lock, so the asset cannot change in between.
 */
export async function saleTerms(
  db: Queryable,
  event: string,
  classId: string,
): Promise<SaleTerms | null> {
  const row = (
    await db.query<{ asset: SaleAsset | null; price: string | null }>(
      `SELECT (SELECT asset FROM event_sale_assets WHERE event = $1) AS asset,
              (SELECT price FROM ticket_classes WHERE id = $2 AND event = $1) AS price`,
      [event, classId],
    )
  ).rows[0];
  if (row === undefined || row.asset === null || row.price === null) return null;
  return { asset: row.asset, price: Number(row.price) };
}

/**
 * Whether the event has had any hold, in any status. A sale needs a hold, so this
 * is also whether it has had a sale: its sale asset is fixed once it has.
 */
export async function hasHadHold(db: Queryable, event: string): Promise<boolean> {
  const found = await db.query("SELECT 1 FROM holds WHERE event = $1 LIMIT 1", [event]);
  return (found.rowCount ?? 0) > 0;
}

/** What counts against an allocation, read under its locks. */
export interface AllocationCounts {
  /** Outstanding holds for the event. */
  readonly eventHolds: number;
  /** Outstanding holds for the class. */
  readonly classHolds: number;
  /** Whether an outstanding hold holds the target's seat. */
  readonly seatHeld: boolean;
  /** Granted issuances of the event the ledger has not refused. */
  readonly granted: number;
  /** Granted issuances of the class the ledger has not refused. */
  readonly classGranted: number;
  /** The class quota; `null` for none. */
  readonly quota: number | null;
}

interface CountsRow {
  readonly event_holds: string;
  readonly class_holds: string;
  readonly seat_held: boolean;
  readonly granted: string;
  readonly class_granted: string;
  readonly quota: string | null;
}

/**
 * Records the event's expired holds as lapsed — a hold stops counting the moment
 * it expires — then counts what stands against `target`. Call under
 * {@link lockAllocation}.
 */
export async function allocationCounts(
  db: Queryable,
  target: AllocationTarget,
  at: Date,
): Promise<AllocationCounts> {
  await db.query(
    `UPDATE holds SET status = 'lapsed', ended_at = expires_at
     WHERE event = $1 AND status = 'outstanding' AND expires_at <= $2`,
    [target.event, at],
  );
  const row = (
    await db.query<CountsRow>(
      `SELECT
         (SELECT count(*) FROM holds WHERE event = $1 AND status = 'outstanding') AS event_holds,
         (SELECT count(*) FROM holds WHERE class_id = $2 AND status = 'outstanding') AS class_holds,
         EXISTS (SELECT 1 FROM holds
                 WHERE event = $1 AND zone = $3 AND position = $4 AND status = 'outstanding')
           AS seat_held,
         (SELECT count(*) FROM granted_issuances WHERE event = $1 AND status <> 'rejected')
           AS granted,
         (SELECT count(*) FROM granted_issuances WHERE class_id = $2 AND status <> 'rejected')
           AS class_granted,
         (SELECT quota FROM ticket_classes WHERE id = $2) AS quota`,
      [target.event, target.classId, target.zone, target.position],
    )
  ).rows[0] as CountsRow;
  return {
    eventHolds: Number(row.event_holds),
    classHolds: Number(row.class_holds),
    seatHeld: row.seat_held,
    granted: Number(row.granted),
    classGranted: Number(row.class_granted),
    quota: row.quota === null ? null : Number(row.quota),
  };
}

/**
 * How many more allocations the event's capacity admits (`INV-4`, `REQ-HD-3`):
 * its capacity less tickets issued as the ledger counts them — or as Kippu has
 * undertaken to issue them, if the ledger has not yet recorded every one — and
 * outstanding holds. `null` when issuance is unbounded.
 */
export function capacityRemaining(
  event: Pick<Event, "maxCapacity" | "issued">,
  counts: AllocationCounts,
): number | null {
  if (event.maxCapacity === null) return null;
  const issued = Math.max(event.issued, counts.granted);
  return Math.max(0, event.maxCapacity - issued - counts.eventHolds);
}

/** Whether one more allocation fits the event's capacity (`INV-4`, `REQ-HD-3`). */
export function capacityHasRoom(
  event: Pick<Event, "maxCapacity" | "issued">,
  counts: AllocationCounts,
): boolean {
  const remaining = capacityRemaining(event, counts);
  return remaining === null || remaining > 0;
}

/**
 * How many more allocations the class quota admits (`REQ-TC-5`, `REQ-HD-3`):
 * holds and granted issuances together. `null` for a class with no quota.
 */
export function quotaRemaining(counts: AllocationCounts): number | null {
  if (counts.quota === null) return null;
  return Math.max(0, counts.quota - counts.classHolds - counts.classGranted);
}

/** Whether one more allocation fits the class quota (`REQ-TC-5`, `REQ-HD-3`): holds and granted issuances together. */
export function quotaHasRoom(counts: AllocationCounts): boolean {
  const remaining = quotaRemaining(counts);
  return remaining === null || remaining > 0;
}

/** The canonical designations of a zone's seats outstanding holds hold. */
export async function heldPositions(
  db: Queryable,
  event: string,
  zone: string,
  at: Date,
): Promise<ReadonlySet<string>> {
  const result = await db.query<{ position: string }>(
    `SELECT position FROM holds
     WHERE event = $1 AND zone = $2 AND position IS NOT NULL AND status = 'outstanding'
       AND expires_at > $3`,
    [event, zone, at],
  );
  return new Set(result.rows.map((row) => row.position));
}
