import type { EventId, Position, ZoneId } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import { ownedEvent } from "./ownership.js";
import type {
  AddSeatPositionsInput,
  AddZoneInput,
  EventsRequest,
  Recorded,
  SeatPositions,
  ZoneInput,
} from "./ports.js";

/** The longest seat designation accepted, in UTF-16 code units. */
export const MAX_DESIGNATION_LENGTH = 100;

/**
 * The ledger `Position` of a seat designation: its UTF-8 bytes, as lower-case
 * hex. The ledger treats a position as opaque bytes (`F-003` plan §5.7), so the
 * designation on the zone's canonical list is exactly what its ticket's identity
 * is derived from (`REQ-ID-1`).
 */
export function positionOf(designation: string): Position {
  if (!designation.isWellFormed()) {
    throw new TypeError("a seat designation must be well-formed Unicode");
  }
  return Buffer.from(designation, "utf8").toString("hex") as Position;
}

export interface Zones {
  addZone(organiserId: string, request: EventsRequest, input: AddZoneInput): Promise<Recorded>;
  removeZone(organiserId: string, request: EventsRequest, input: ZoneInput): Promise<Recorded>;
  addSeatPositions(
    organiserId: string,
    request: EventsRequest,
    input: AddSeatPositionsInput,
  ): Promise<SeatPositions>;
  seatPositions(organiserId: string, input: ZoneInput): Promise<SeatPositions>;
  /**
   * The ledger `Position` of `designation`, provided it is one of the zone's
   * canonical positions. Anything else — a position the organiser never
   * uploaded, a case or punctuation variant of one, a zone with no list —
   * throws `RefusedRequest`, so issuance refuses it before anything is signed
   * or submitted (`REQ-ID-3`; `F-021` plan §5.3).
   */
  canonicalPosition(event: string, zone: string, designation: string): Promise<Position>;
}

export interface ZonesOptions {
  readonly store: Store;
  readonly authority: Pick<OrganiserAuthority, "account" | "relay">;
  readonly ledger: Pick<KippuTicketto, "getEvent" | "addZone" | "removeZone">;
  readonly now?: () => Date;
}

export function createZones(options: ZonesOptions): Zones {
  const { store, authority, ledger, now = () => new Date() } = options;

  /** The ledger's verdict: the write's cursor, or its §10 refusal thrown. */
  const settledOrThrow = (result: Awaited<ReturnType<KippuTicketto["addZone"]>>): Recorded => {
    if (!result.ok) {
      throw new SpecCodeError(result.error.code, result.error.detail);
    }
    return { cursor: result.value.cursor };
  };

  const positionsOf = async (event: string, zone: string): Promise<SeatPositions> => {
    const rows = await store.query<{ designation: string }>(
      "SELECT designation FROM seat_positions WHERE event = $1 AND zone = $2 ORDER BY id",
      [event, zone],
    );
    return { event, zone, positions: rows.rows.map((row) => row.designation) };
  };

  return {
    async addZone(organiserId, request, input) {
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      // A submission is a promise of its result, so awaiting the relayed write yields the verdict.
      const result = await authority.relay(organiserId, request, (signer) =>
        ledger.addZone(signer, {
          event: input.event as EventId,
          zone: { id: input.zone.id as ZoneId, kind: input.zone.kind },
        }),
      );
      return settledOrThrow(result);
    },

    async removeZone(organiserId, request, input) {
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      const result = await authority.relay(organiserId, request, (signer) =>
        ledger.removeZone(signer, { event: input.event as EventId, zone: input.zone as ZoneId }),
      );
      const recorded = settledOrThrow(result);
      // The zone is gone from the ledger, and its positions with it: a zone later added
      // under the same id starts with no canonical positions.
      await store.query("DELETE FROM seat_positions WHERE event = $1 AND zone = $2", [
        input.event,
        input.zone,
      ]);
      return recorded;
    },

    async addSeatPositions(organiserId, request, input) {
      const { event } = await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      const zone = event.zones.find(({ id }) => id === input.zone);
      if (zone === undefined) {
        throw new SpecCodeError(
          "ERR-UnknownZone",
          `zone ${input.zone} is not defined for the event`,
        );
      }
      if (zone.kind !== "Seated") {
        throw new SpecCodeError("ERR-ZoneKindMismatch", "only a seated zone has seat positions");
      }
      for (const designation of input.positions) {
        if (
          designation.length === 0 ||
          designation.length > MAX_DESIGNATION_LENGTH ||
          !designation.isWellFormed()
        ) {
          throw new RefusedRequest("a seat position is 1 to 100 characters of well-formed Unicode");
        }
      }
      await store.query(
        `INSERT INTO seat_positions (event, zone, designation, created_request_id, created_at)
         SELECT $1, $2, designation, $4, $5 FROM unnest($3::text[]) WITH ORDINALITY AS u(designation, n)
         ORDER BY n
         ON CONFLICT (event, zone, designation) DO NOTHING`,
        [input.event, input.zone, input.positions, request.requestId, now()],
      );
      return positionsOf(input.event, input.zone);
    },

    async seatPositions(organiserId, input) {
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      return positionsOf(input.event, input.zone);
    },

    async canonicalPosition(event, zone, designation) {
      const found = await store.query(
        "SELECT 1 FROM seat_positions WHERE event = $1 AND zone = $2 AND designation = $3",
        [event, zone, designation],
      );
      if (found.rowCount !== 1) {
        throw new RefusedRequest(
          `"${designation}" is not one of the zone's canonical seat positions`,
        );
      }
      return positionOf(designation);
    },
  };
}
