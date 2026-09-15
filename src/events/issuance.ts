import { randomBytes } from "node:crypto";
import type {
  AccountId,
  ClassId,
  Discriminator,
  EventId,
  Placement,
  Position,
  Receipt,
  Result,
  ZoneId,
} from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import type { Classes } from "../classes/classes.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import { ownedEvent } from "./ownership.js";
import type { EventsRequest, IssuedTicket, IssueGrantedInput, TicketClass } from "./ports.js";
import type { SeatAllocation } from "./seats.js";
import { positionOf, type Zones } from "./zones.js";

/** Bytes in an unseated placement's discriminator: 128 random bits (`AD-12`). */
export const DISCRIMINATOR_BYTES = 16;

export interface IssuanceOptions {
  readonly store: Store;
  readonly authority: Pick<OrganiserAuthority, "account" | "relay">;
  readonly ledger: Pick<KippuTicketto, "getEvent" | "issueTicket">;
  readonly classes: Pick<Classes, "find">;
  readonly zones: Pick<Zones, "canonicalPosition">;
  /** The seated double-allocation pre-check (`T-021-06`). */
  readonly seats: Pick<SeatAllocation, "lock" | "assertFree">;
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
}

/**
 * Granted issuance (`US-B2`; `F-021` plan §5.2, §5.6), in order:
 *
 * 1. The organiser owns the event, on the ledger (`ERR-EventNotFound`, `ERR-NotOwner`).
 * 2. The class is defined for the event (`ERR-UnknownClass`), and is `Granted`:
 *    a `Purchased` class's tickets are sold through checkout (`F-022`), never
 *    issued free.
 * 3. A seat is one of its zone's canonical positions, in NFC (`REQ-ID-3`), refused
 *    before anything is signed; and no ticket, nor issuance in flight, already
 *    holds it (`AC-B5.2`), or `ERR-TicketIdExists` before submission. Where the zone is unknown or unseated, the
 *    ledger's own verdict (`ERR-UnknownZone`, `ERR-ZoneKindMismatch`) is left to
 *    it. An unseated placement gets a random discriminator.
 * 4. Under a lock on the class, the class quota has room (`ERR-ClassQuotaExceeded`,
 *    `REQ-TC-5`), and the issuance is recorded, so that it counts.
 * 5. `issueTicket` is signed with the organiser's authority. It carries `Granted`
 *    provenance and the class's id, policy and restrictions, never ones of the
 *    request (`REQ-TC-2`, `REQ-TK-4`). The SDK derives the ticket id through the
 *    profile (`REQ-ID-1`), and the ledger applies every rule of its own —
 *    capacity included (`AC-B2.5`).
 *
 * No payment flow of any kind takes place, and nothing records one (`REQ-TC-4`).
 */
export function issueGrantedWith(options: IssuanceOptions) {
  const { store, authority, ledger, classes, zones, seats, now = () => new Date() } = options;
  const random = options.randomBytes ?? ((length: number) => randomBytes(length));

  /**
   * Records the issuance, provided the seat — for a canonical seat — is free
   * (`AC-B5.2`) and the class quota has room. The seat is locked first, as every
   * allocation of a seat locks it first. Returns the record's id.
   */
  const reserve = async (
    organiserId: string,
    request: EventsRequest,
    input: IssueGrantedInput,
    seat: Position | null,
  ): Promise<string> => {
    const client = await store.connect();
    try {
      await client.query("BEGIN");
      let ticket: string | null = null;
      if (seat !== null) {
        await seats.lock(client, input.event, input.zone, seat);
        ticket = await seats.assertFree(client, input.event, input.zone, seat);
      }
      const locked = await client.query<{ quota: string | null }>(
        "SELECT quota FROM ticket_classes WHERE id = $1 AND event = $2 FOR UPDATE",
        [input.class, input.event],
      );
      const row = locked.rows[0];
      if (row === undefined) {
        throw new SpecCodeError("ERR-UnknownClass", "the class is not defined for the event");
      }
      if (row.quota !== null) {
        const counted = await client.query<{ count: string }>(
          "SELECT count(*) FROM granted_issuances WHERE class_id = $1 AND status <> 'rejected'",
          [input.class],
        );
        if (Number(counted.rows[0]?.count) >= Number(row.quota)) {
          throw new SpecCodeError(
            "ERR-ClassQuotaExceeded",
            `the class quota of ${row.quota} is reached`,
          );
        }
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO granted_issuances
           (event, class_id, ticket, holder, organiser_id, request_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [input.event, input.class, ticket, input.holder, organiserId, request.requestId, now()],
      );
      await client.query("COMMIT");
      return inserted.rows[0]?.id as string;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  const complete = async (id: string, outcome: Result<Receipt> | "failed"): Promise<void> => {
    if (outcome === "failed") {
      await store.query(
        "UPDATE granted_issuances SET status = 'failed', completed_at = $2 WHERE id = $1",
        [id, now()],
      );
    } else if (outcome.ok) {
      await store.query(
        `UPDATE granted_issuances
         SET status = 'settled', operation_id = $2, receipt_cursor = $3, completed_at = $4
         WHERE id = $1`,
        [id, outcome.value.operationId, outcome.value.cursor, now()],
      );
    } else {
      await store.query(
        `UPDATE granted_issuances SET status = 'rejected', error_code = $2, completed_at = $3
         WHERE id = $1`,
        [id, outcome.error.code, now()],
      );
    }
  };

  /** `issueTicket`, signed with the organiser's authority, carrying what the class determines. */
  const relayIssue = (
    organiserId: string,
    request: EventsRequest,
    input: IssueGrantedInput,
    placement: Placement,
    ticketClass: TicketClass,
  ) =>
    authority.relay(organiserId, request, (signer) =>
      ledger.issueTicket(signer, {
        event: input.event as EventId,
        zone: input.zone as ZoneId,
        placement,
        class: ticketClass.id as ClassId,
        provenance: "Granted",
        policy: ticketClass.policy,
        restrictions: ticketClass.restrictions,
        holder: input.holder as AccountId,
        metadata: null,
      }),
    );

  return async (
    organiserId: string,
    request: EventsRequest,
    input: IssueGrantedInput,
  ): Promise<IssuedTicket> => {
    const { event } = await ownedEvent(ledger, authority, organiserId, input.event as EventId);

    const ticketClass = await classes.find(input.event, input.class);
    if (ticketClass === null) {
      throw new SpecCodeError("ERR-UnknownClass", "the class is not defined for the event");
    }
    if (ticketClass.provenance !== "Granted") {
      throw new RefusedRequest(
        "a Purchased class's tickets are sold through checkout, not issued as granted tickets",
      );
    }

    let placement: Placement;
    // A canonical seat of a seated zone, checked for double allocation before submission.
    let seat: Position | null = null;
    if (input.placement.kind === "Seated") {
      const zone = event.zones.find(({ id }) => id === input.zone);
      if (zone?.kind === "Seated") {
        seat = await zones.canonicalPosition(input.event, input.zone, input.placement.position);
      }
      placement = {
        kind: "Seated",
        // The ledger refuses a seat in an unknown or unseated zone with its own code.
        position: seat ?? positionOf(input.placement.position),
      };
    } else {
      placement = {
        kind: "Unseated",
        discriminator: Buffer.from(random(DISCRIMINATOR_BYTES)).toString("hex") as Discriminator,
      };
    }

    const reservation = await reserve(organiserId, request, input, seat);
    let issued: Awaited<ReturnType<typeof relayIssue>>;
    try {
      issued = await relayIssue(organiserId, request, input, placement, ticketClass);
    } catch (error) {
      // Nothing was signed: the issuance never happened, and does not count.
      await store.query("DELETE FROM granted_issuances WHERE id = $1", [reservation]);
      throw error;
    }
    await store.query("UPDATE granted_issuances SET ticket = $2 WHERE id = $1", [
      reservation,
      issued.id,
    ]);
    let outcome: Result<Receipt>;
    try {
      outcome = await issued.submission;
    } catch (error) {
      await complete(reservation, "failed");
      throw error;
    }
    await complete(reservation, outcome);
    if (!outcome.ok) {
      throw new SpecCodeError(outcome.error.code, outcome.error.detail);
    }
    return { ticket: issued.id, cursor: outcome.value.cursor };
  };
}
