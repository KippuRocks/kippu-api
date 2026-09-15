import type { EventId } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { SpecCodeError } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import { lockEventAllocations } from "../sales/allocation.js";
import type { OrganiserSaleActions } from "../sales/organiser-actions.js";
import type { Store } from "../store/store.js";
import { ownedEvent } from "./ownership.js";
import type { CapacityChanged, DecreaseCapacityInput, EventsRequest } from "./ports.js";

export interface CapacityOptions {
  readonly store: Store;
  readonly authority: Pick<OrganiserAuthority, "account" | "relay">;
  readonly ledger: Pick<KippuTicketto, "getEvent" | "setEventCapacity">;
  /**
   * `F-022`'s organiser sale actions (`T-022-05`), resolved when called: sales are
   * created after events, from events' classes and seats.
   */
  readonly saleActions: () => Pick<OrganiserSaleActions, "canDecreaseCapacity">;
}

export interface Capacity {
  decrease(
    organiserId: string,
    request: EventsRequest,
    input: DecreaseCapacityInput,
  ): Promise<CapacityChanged>;
}

/**
 * Capacity decreases (`T-021-07`; `US-A6`, `REQ-EV-4`, `REQ-HD-4`; `F-021` plan
 * §5.4). Decreasing is always permitted down to what the event already bears —
 * never below it — and needs no proof. Bounding an event that has none is a
 * decrease, from unbounded to the bound (`F-008` plan §5.7a); removing a bound
 * is an increase (`REQ-EV-7`), which this call cannot express.
 *
 * Under the event's allocation lock (`src/sales/allocation.ts`), so no hold or
 * issuance lands between the check and the ledger's verdict:
 * 1. an increase — a capacity above the current bound — is refused with
 *    `ERR-CapacityProofRequired` before it reaches the ledger: increases go
 *    through proof review (`T-021-08`);
 * 2. on an `Active` event, a capacity below issued tickets plus outstanding holds
 *    — `F-022`'s `canDecreaseCapacity`, counted with the shared allocation
 *    module — is refused with `ERR-CapacityBelowIssuance` (`REQ-HD-4`), with
 *    reason `held` when the ledger's issued count alone would allow it. The ledger's own floor,
 *    `issued`, stays the guarantee (`INV-11`). Any other status is the ledger's
 *    to refuse (`REQ-EV-8`);
 * 3. `setEventCapacity` is signed with the organiser's authority, and the
 *    ledger's verdict passed on.
 */
export function createCapacity(options: CapacityOptions): Capacity {
  const { store, authority, ledger, saleActions } = options;

  return {
    async decrease(organiserId, request, input) {
      const client = await store.connect();
      try {
        await client.query("BEGIN");
        await lockEventAllocations(client, input.event);
        // Read under the lock: capacity and issued as the ledger has them now.
        const { event } = await ownedEvent(ledger, authority, organiserId, input.event as EventId);
        if (event.maxCapacity !== null && input.capacity > event.maxCapacity) {
          throw new SpecCodeError(
            "ERR-CapacityProofRequired",
            "an increase needs a capacity proof approved by Kippu operations",
          );
        }
        if (
          event.status === "Active" &&
          !(await saleActions().canDecreaseCapacity(input.event, input.capacity, client))
        ) {
          throw new SpecCodeError(
            "ERR-CapacityBelowIssuance",
            "the capacity is below the tickets issued and held",
            input.capacity >= event.issued ? "held" : null,
          );
        }
        const result = await authority.relay(organiserId, request, (signer) =>
          ledger.setEventCapacity(signer, {
            event: input.event as EventId,
            capacity: input.capacity,
            proof: null,
          }),
        );
        if (!result.ok) {
          throw new SpecCodeError(result.error.code, result.error.detail);
        }
        await client.query("COMMIT");
        return { event: input.event, capacity: input.capacity, cursor: result.value.cursor };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
