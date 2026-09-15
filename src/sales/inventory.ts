import type { EventId, TicketId } from "@ticketto/sdk";
import { SpecCodeError } from "../authority/errors.js";
import type { AttendancePolicy } from "../events/ports.js";
import type { SeatAllocation } from "../events/seats.js";
import { positionOf } from "../events/zones.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import {
  allocationCounts,
  capacityRemaining,
  heldPositions,
  quotaRemaining,
} from "./allocation.js";
import type { ClassOnSale, SaleInventory, ZoneOnSale } from "./ports.js";

export interface InventoryOptions {
  readonly store: Store;
  readonly ledger: Pick<KippuTicketto, "getEvent">;
  readonly seats: Pick<SeatAllocation, "ticketOf">;
  readonly now?: () => Date;
}

export interface Inventory {
  /** The event's public sale inventory; `ERR-EventNotFound` when the ledger has no such event. */
  inventory(event: string): Promise<SaleInventory>;
}

interface ClassRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly price: string;
  readonly policy: AttendancePolicy;
}

const lesser = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b);

/**
 * Public sale inventory (`T-022-10`; `REQ-MP-7`, `REQ-HD-3`, `US-B5`).
 *
 * The event, its capacity and issued count are read from the ledger, as a hold
 * reads them; availability is counted with the same accounting a hold is placed
 * with (`src/sales/allocation.ts`), so it drops the moment a hold is open. A
 * seat is offered only when no ticket holds it — on the ledger as Kippu's
 * derived copy reflects it, or as Kippu has undertaken to issue it — and no
 * outstanding hold does. The copy may lag the ledger (`NFR-11`): an offered
 * seat can still be refused at the hold, never the reverse for Kippu's own
 * issuances.
 */
export function createInventory(options: InventoryOptions): Inventory {
  const { store, ledger, seats, now = () => new Date() } = options;

  return {
    async inventory(eventId) {
      const found = await ledger.getEvent(eventId as EventId);
      if (!found.ok) {
        throw new SpecCodeError(found.error.code, found.error.detail);
      }
      const event = found.value;
      const asset =
        (
          await store.query<{ asset: SaleInventory["asset"] }>(
            "SELECT asset FROM event_sale_assets WHERE event = $1",
            [eventId],
          )
        ).rows[0]?.asset ?? null;
      // Nothing is held before the organiser chooses what the event's prices are in.
      if (event.status !== "Active" || asset === null) {
        return { event: eventId, onSale: false, asset, available: 0, classes: [], zones: [] };
      }
      const at = now();

      const classRows = await store.query<ClassRow>(
        `SELECT id, name, description, price, policy FROM ticket_classes
         WHERE event = $1 AND provenance = 'Purchased' AND price IS NOT NULL
         ORDER BY created_at, id`,
        [eventId],
      );
      // The event's counts do not depend on the class or placement; any target reads them.
      const eventCounts = await allocationCounts(
        store,
        { event: eventId, zone: "", classId: "", position: null },
        at,
      );
      const available = capacityRemaining(event, eventCounts);

      const classes: ClassOnSale[] = [];
      for (const row of classRows.rows) {
        const counts = await allocationCounts(
          store,
          { event: eventId, zone: "", classId: row.id, position: null },
          at,
        );
        classes.push({
          id: row.id,
          name: row.name,
          description: row.description,
          price: Number(row.price),
          policy: row.policy,
          available: lesser(available, quotaRemaining(counts)),
        });
      }

      // Tickets that hold seats: those the copy reflects, and those Kippu is issuing or issued.
      const taken = new Set(
        (
          await store.query<{ id: string }>(
            `SELECT id FROM derived_tickets WHERE event_id = $1 AND placement_kind = 'Seated'
             UNION
             SELECT ticket FROM granted_issuances
             WHERE event = $1 AND ticket IS NOT NULL AND status <> 'rejected'`,
            [eventId],
          )
        ).rows.map((row) => row.id),
      );

      const zones: ZoneOnSale[] = [];
      for (const zone of event.zones) {
        if (zone.kind === "Unseated") {
          zones.push({ id: zone.id, kind: "Unseated" });
          continue;
        }
        const designations = await store.query<{ designation: string }>(
          "SELECT designation FROM seat_positions WHERE event = $1 AND zone = $2 ORDER BY id",
          [eventId, zone.id],
        );
        const held = await heldPositions(store, eventId, zone.id, at);
        const freeSeats =
          available === 0
            ? []
            : designations.rows
                .map((row) => row.designation)
                .filter(
                  (designation) =>
                    !held.has(designation) &&
                    !taken.has(
                      seats.ticketOf(eventId, zone.id, positionOf(designation)) as TicketId,
                    ),
                );
        zones.push({ id: zone.id, kind: "Seated", freeSeats });
      }

      return { event: eventId, onSale: true, asset, available, classes, zones };
    },
  };
}
