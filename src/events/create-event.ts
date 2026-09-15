import { randomBytes } from "node:crypto";
import { eventLocator, METADATA_ORIGIN } from "@kippu/metadata-schema";
import { eventId as deriveEventId } from "@ticketto/profile-v0";
import type { EventId, ZoneId } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { SpecCodeError } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import type { CreatedEvent, CreateEventInput, EventsRequest } from "./ports.js";
import type { SaleAssets } from "./sale-assets.js";

/** Bytes in the salt an `EventId` is derived from with the owner's account (`AD-12`). */
export const EVENT_SALT_BYTES = 32;

export interface CreateEventOptions {
  readonly store: Store;
  readonly authority: Pick<OrganiserAuthority, "relay">;
  readonly ledger: Pick<KippuTicketto, "createEvent">;
  /** Records a sale asset chosen at creation (`T-021-14`). */
  readonly saleAssets: Pick<SaleAssets, "recordAtCreation">;
  /**
   * The public origin metadata locators name (`AD-22`): the metadata
   * configuration's `publicUrl`. Defaults to `https://meta.kippu.rocks`.
   */
  readonly metadataPublicUrl?: string;
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
}

/**
 * `create_event` on the organiser's behalf (`US-A1`, `REQ-OA-1`). The event is
 * signed with the organiser's authority, so the ledger records their account as
 * its owner, `Active` (`AC-A1.1`). Its id is derived by the SDK through the
 * profile from that account and a fresh random salt, never allocated
 * (`REQ-EV-9`). The ledger's verdict is passed on unchanged: a refusal —
 * `ERR-ZoneExists` for a zone id named twice, say — throws its §10 code.
 *
 * The event's metadata locator is allocated here and recorded on the ledger
 * with it (`REQ-MD-1`, `F-026` plan §5.1): the stable URL its document is
 * served at, named by its id, whether or not a document exists yet. No document
 * is written: an organiser writes one by editing (`T-026-04`), and a client
 * renders the event from ledger facts alone until then (`REQ-MD-2`).
 *
 * Once the ledger has recorded the event, it is linked to the organiser in
 * `organiser_events` with the receipt's cursor and the locator.
 */
export function createEventWith(options: CreateEventOptions) {
  const { store, authority, ledger, now = () => new Date() } = options;
  const origin = options.metadataPublicUrl ?? METADATA_ORIGIN;
  const random = options.randomBytes ?? ((length: number) => randomBytes(length));

  return async (
    organiserId: string,
    request: EventsRequest,
    input: CreateEventInput,
  ): Promise<CreatedEvent> => {
    let locator = "";
    const created = await authority.relay(organiserId, request, (signer) => {
      const salt = random(EVENT_SALT_BYTES);
      // The id is needed before signing, to name the locator the command carries.
      const id = deriveEventId(signer.account, salt);
      locator = eventLocator(id, origin);
      const derived = ledger.createEvent(signer, {
        salt,
        zones: input.zones.map(({ id: zone, kind }) => ({ id: zone as ZoneId, kind })),
        capacity: input.capacity,
        metadata: locator,
      });
      if (derived.id !== (id as EventId)) {
        // The profile in force derives ids differently: the locator would name another event.
        throw new Error("the SDK derived a different EventId than the one the locator names");
      }
      return derived;
    });
    const result = await created.submission;
    if (!result.ok) {
      throw new SpecCodeError(result.error.code, result.error.detail);
    }
    const { operationId, cursor } = result.value;
    await store.query(
      `INSERT INTO organiser_events
         (event, organiser_id, operation_id, created_request_id, receipt_cursor, created_at,
          metadata_locator)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event) DO NOTHING`,
      [created.id, organiserId, operationId, request.requestId, cursor, now(), locator],
    );
    if (input.saleAsset !== undefined && input.saleAsset !== null) {
      await options.saleAssets.recordAtCreation(organiserId, request, created.id, input.saleAsset);
    }
    return { event: created.id, cursor };
  };
}
