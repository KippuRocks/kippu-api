import { randomBytes } from "node:crypto";
import type { ZoneId } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { SpecCodeError } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import type { CreatedEvent, CreateEventInput, EventsRequest } from "./ports.js";

/** Bytes in the salt an `EventId` is derived from with the owner's account (`AD-12`). */
export const EVENT_SALT_BYTES = 32;

export interface CreateEventOptions {
  readonly store: Store;
  readonly authority: Pick<OrganiserAuthority, "relay">;
  readonly ledger: Pick<KippuTicketto, "createEvent">;
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
 * Once the ledger has recorded the event, it is linked to the organiser in
 * `organiser_events` with the receipt's cursor.
 */
export function createEventWith(options: CreateEventOptions) {
  const { store, authority, ledger, now = () => new Date() } = options;
  const random = options.randomBytes ?? ((length: number) => randomBytes(length));

  return async (
    organiserId: string,
    request: EventsRequest,
    input: CreateEventInput,
  ): Promise<CreatedEvent> => {
    const created = await authority.relay(organiserId, request, (signer) =>
      ledger.createEvent(signer, {
        salt: random(EVENT_SALT_BYTES),
        zones: input.zones.map(({ id, kind }) => ({ id: id as ZoneId, kind })),
        capacity: input.capacity,
        // The event's metadata locator is allocated by T-026-03.
        metadata: null,
      }),
    );
    const result = await created.submission;
    if (!result.ok) {
      throw new SpecCodeError(result.error.code, result.error.detail);
    }
    const { operationId, cursor } = result.value;
    await store.query(
      `INSERT INTO organiser_events
         (event, organiser_id, operation_id, created_request_id, receipt_cursor, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event) DO NOTHING`,
      [created.id, organiserId, operationId, request.requestId, cursor, now()],
    );
    return { event: created.id, cursor };
  };
}
