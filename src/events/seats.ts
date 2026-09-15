import { ticketId } from "@ticketto/profile-v0";
import type { EventId, Position, TicketId, ZoneId } from "@ticketto/sdk";
import { SpecCodeError } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";

/** Anything that runs a query: the store, or a client in a transaction. */
export type Queryable = Pick<Store, "query">;

/**
 * The seated double-allocation pre-check (`T-021-06`; `US-B5`, `AC-B5.2`,
 * `REQ-ID-3`). The ledger refuses a second ticket for a seat
 * (`ERR-TicketIdExists`, `REQ-ID-2`) and stays the guarantee; this refuses it at
 * the platform layer, before anything is signed or submitted, so the organiser
 * or buyer gets the reason rather than a collision.
 *
 * A seat's identity is its ticket id, derived through the profile from event,
 * zone and position (`REQ-ID-1`), so every way of allocating a seat — granted
 * issuance here, holds in checkout (`F-022`) — checks the same thing. Call
 * {@link SeatAllocation.lock} and then {@link SeatAllocation.assertFree} inside
 * the transaction that records the allocation: two allocations of one seat then
 * never both pass.
 */
export interface SeatAllocation {
  /** The ticket id a seat's ticket has: the profile's derivation (`REQ-ID-1`). */
  ticketOf(event: string, zone: string, position: Position): TicketId;
  /**
   * Holds a transaction-scoped lock on the seat, so concurrent allocations of it
   * are checked one after another. `db` must be a client inside a transaction.
   */
  lock(db: Queryable, event: string, zone: string, position: Position): Promise<TicketId>;
  /**
   * The seat's ticket id, provided the seat is free: the ledger holds no ticket
   * for it, and Kippu has no granted issuance of it that the ledger has not
   * refused. Otherwise `ERR-TicketIdExists`.
   */
  assertFree(db: Queryable, event: string, zone: string, position: Position): Promise<TicketId>;
}

export interface SeatAllocationOptions {
  readonly ledger: Pick<KippuTicketto, "getTicket">;
}

export function createSeatAllocation(options: SeatAllocationOptions): SeatAllocation {
  const { ledger } = options;
  const ticketOf = (event: string, zone: string, position: Position): TicketId =>
    ticketId(event as EventId, zone as ZoneId, { kind: "Seated", position });

  return {
    ticketOf,

    async lock(db, event, zone, position) {
      const ticket = ticketOf(event, zone, position);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `kippu/seat/${ticket}`,
      ]);
      return ticket;
    },

    async assertFree(db, event, zone, position) {
      const ticket = ticketOf(event, zone, position);
      const inFlight = await db.query(
        "SELECT 1 FROM granted_issuances WHERE ticket = $1 AND status <> 'rejected' LIMIT 1",
        [ticket],
      );
      if ((inFlight.rowCount ?? 0) > 0) {
        throw new SpecCodeError("ERR-TicketIdExists", "the seat is already allocated");
      }
      const onLedger = await ledger.getTicket(ticket);
      if (onLedger.ok) {
        throw new SpecCodeError("ERR-TicketIdExists", "the seat is already issued");
      }
      if (onLedger.error.code !== "ERR-TicketNotFound") {
        throw new SpecCodeError(onLedger.error.code, onLedger.error.detail);
      }
      return ticket;
    },
  };
}
