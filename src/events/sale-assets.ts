import type { EventId } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { RefusedRequest } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import { hasHadHold, lockEventAllocations, unpricedClasses } from "../sales/allocation.js";
import type { Store } from "../store/store.js";
import { ownedEvent } from "./ownership.js";
import type {
  EventInput,
  EventSaleAsset,
  EventsRequest,
  SaleAsset,
  SetSaleAssetInput,
} from "./ports.js";

export interface SaleAssets {
  set(
    organiserId: string,
    request: EventsRequest,
    input: SetSaleAssetInput,
  ): Promise<EventSaleAsset>;
  get(organiserId: string, input: EventInput): Promise<EventSaleAsset>;
  /** Records the asset chosen when the event was created: it has had no hold yet. */
  recordAtCreation(
    organiserId: string,
    request: EventsRequest,
    event: string,
    asset: SaleAsset,
  ): Promise<void>;
}

export interface SaleAssetsOptions {
  readonly store: Store;
  readonly authority: Pick<OrganiserAuthority, "account">;
  readonly ledger: Pick<KippuTicketto, "getEvent">;
  readonly now?: () => Date;
}

/**
 * Each event's sale asset (`T-021-14`; `F-021` plan, "Prices"): chosen by the
 * organiser, at creation or later, and fixed once the event has had a hold or a
 * sale. It is Kippu's, and never reaches the ledger (`AC-B4.2`). Changing it from
 * one asset to another clears every `Purchased` class's price in the same
 * transaction; the event is not on sale until each is re-priced. Choosing the
 * first asset, or setting the one in force, clears nothing.
 *
 * A change is made under the event's allocation lock — the lock every hold is
 * placed under (`src/sales/allocation.ts`) — so no hold can be placed between
 * the check and the change.
 */
export function createSaleAssets(options: SaleAssetsOptions): SaleAssets {
  const { store, authority, ledger, now = () => new Date() } = options;

  const upsert = (
    db: Pick<Store, "query">,
    organiserId: string,
    request: EventsRequest,
    event: string,
    asset: SaleAsset,
  ) =>
    db.query(
      `INSERT INTO event_sale_assets (event, asset, organiser_id, set_request_id, set_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event) DO UPDATE
         SET asset = EXCLUDED.asset, organiser_id = EXCLUDED.organiser_id,
             set_request_id = EXCLUDED.set_request_id, set_at = EXCLUDED.set_at`,
      [event, asset, organiserId, request.requestId, now()],
    );

  const read = async (db: Pick<Store, "query">, event: string): Promise<EventSaleAsset> => {
    const row = (
      await db.query<{ asset: SaleAsset | null }>(
        "SELECT (SELECT asset FROM event_sale_assets WHERE event = $1) AS asset",
        [event],
      )
    ).rows[0];
    return {
      event,
      asset: row?.asset ?? null,
      fixed: await hasHadHold(db, event),
      unpriced: await unpricedClasses(db, event),
    };
  };

  return {
    async set(organiserId, request, input) {
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      const client = await store.connect();
      try {
        await client.query("BEGIN");
        await lockEventAllocations(client, input.event);
        const current = await read(client, input.event);
        if (current.asset !== input.asset) {
          if (current.fixed) {
            throw new RefusedRequest(
              "the event's sale asset is fixed: it has had a hold or a sale",
              "CONFLICT",
            );
          }
          if (current.asset !== null) {
            // A price is in its asset's minor units: a new asset clears every price rather
            // than letting it change meaning (F-021 plan, "Prices").
            await client.query(
              `UPDATE ticket_classes SET price = NULL, price_set_at = $2
               WHERE event = $1 AND provenance = 'Purchased'`,
              [input.event, now()],
            );
          }
          await upsert(client, organiserId, request, input.event, input.asset);
        }
        const updated = await read(client, input.event);
        await client.query("COMMIT");
        return updated;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async get(organiserId, input) {
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      return read(store, input.event);
    },

    async recordAtCreation(organiserId, request, event, asset) {
      await upsert(store, organiserId, request, event, asset);
    },
  };
}
