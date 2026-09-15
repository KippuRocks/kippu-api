import type { EventId } from "@ticketto/sdk";
import { SpecCodeError } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import { allocatedCount, allocationCounts } from "./allocation.js";
import type { CheckoutCause } from "./audit.js";
import type { Payments, ReleasedSales } from "./payment.js";

/**
 * What `F-021`'s organiser actions call before submitting (`T-022-05`;
 * `REQ-HD-4`, `F-022` plan §5.3, `F-021` plan §5.4–§5.5).
 */
export interface OrganiserSaleActions {
  /**
   * Whether the event's capacity may be lowered to `to`: tickets issued — as the
   * ledger counts them, or as Kippu has undertaken to issue them — plus holds not
   * yet issued, at most `to`. Pass `db`, a client in a transaction holding the
   * event's allocation lock (`lockEventAllocations`), so no hold is placed between
   * the check and the write; the store otherwise. `ERR-EventNotFound` when the
   * ledger has no such event.
   */
  canDecreaseCapacity(event: string, to: number, db?: Pick<Store, "query">): Promise<boolean>;
  /**
   * Before a seal or cancellation is submitted: closes the event's sales, releases
   * every outstanding hold, cancels open hosted checkouts, and records a refund
   * entitlement for any payment already taken against a released hold.
   */
  releaseAll(event: string, cause: CheckoutCause): Promise<ReleasedSales>;
  /** When the seal or cancellation was refused: reopens the event's sales. */
  reopenSales(event: string, cause: CheckoutCause): Promise<boolean>;
}

export interface OrganiserSaleActionsOptions {
  readonly store: Store;
  readonly ledger: Pick<KippuTicketto, "getEvent">;
  readonly payments: Pick<Payments, "releaseAll" | "reopenSales">;
  readonly now?: () => Date;
}

export function createOrganiserSaleActions(
  options: OrganiserSaleActionsOptions,
): OrganiserSaleActions {
  const { store, ledger, payments, now = () => new Date() } = options;
  return {
    async canDecreaseCapacity(event, to, db = store) {
      const found = await ledger.getEvent(event as EventId);
      if (!found.ok) {
        throw new SpecCodeError(found.error.code, found.error.detail);
      }
      const counts = await allocationCounts(
        db,
        { event, zone: "", classId: "", position: null },
        now(),
      );
      return allocatedCount(found.value, counts) <= to;
    },
    releaseAll: (event, cause) => payments.releaseAll(event, cause),
    reopenSales: (event, cause) => payments.reopenSales(event, cause),
  };
}
