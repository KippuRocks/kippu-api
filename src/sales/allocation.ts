import type { Event } from "@ticketto/sdk";
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
  await db.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
    ALLOCATION_LOCK_NAMESPACE,
    target.event,
  ]);
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
 * Whether one more allocation fits the event's capacity (`INV-4`, `REQ-HD-3`):
 * tickets issued as the ledger counts them — or as Kippu has undertaken to issue
 * them, if the ledger has not yet recorded every one — plus outstanding holds.
 */
export function capacityHasRoom(
  event: Pick<Event, "maxCapacity" | "issued">,
  counts: AllocationCounts,
): boolean {
  if (event.maxCapacity === null) return true;
  const issued = Math.max(event.issued, counts.granted);
  return issued + counts.eventHolds < event.maxCapacity;
}

/** Whether one more allocation fits the class quota (`REQ-TC-5`, `REQ-HD-3`): holds and granted issuances together. */
export function quotaHasRoom(counts: AllocationCounts): boolean {
  return counts.quota === null || counts.classHolds + counts.classGranted < counts.quota;
}
