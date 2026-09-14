/**
 * Events, zones, ticket classes and granted issuance, administered by Kippu on
 * an organiser's behalf (`F-021`; `REQ-OA-1`).
 *
 * This module is imported by the tRPC context, whose type is published in
 * `@kippu/api`: it may import nothing at runtime, and names no SDK type.
 * Identifiers cross it as lower-case hex strings.
 */

import type { Principal } from "../auth/ports.js";

/** The request a call acts on behalf of: what its ledger writes are attributed to (`NFR-7`). */
export interface EventsRequest {
  readonly requestId: string;
  readonly principal: Principal;
}

/** How a ticket entered circulation (`SPEC.md` §5.2). */
export type Provenance = "Purchased" | "Granted";

/** How many times, and until when, a ticket admits its holder (§5.2). Times are Unix milliseconds. */
export type AttendancePolicy =
  | { readonly kind: "Single" }
  | { readonly kind: "Multiple"; readonly max: number; readonly until: number | null }
  | { readonly kind: "Unlimited"; readonly until: number | null };

/** A ticket's restrictions (`REQ-TK-1`). */
export interface TicketRestrictions {
  readonly cannotResale: boolean;
  readonly cannotTransfer: boolean;
}

/** Whether a zone's tickets are placed by seat position or by discriminator (§5.5). */
export type ZoneKind = "Seated" | "Unseated";

/** A zone of an event: its identity and kind are ledger facts (`REQ-ID-7`). */
export interface Zone {
  /** The `ZoneId`, chosen by the organiser: 64 lower-case hex characters, unique in the event. */
  readonly id: string;
  readonly kind: ZoneKind;
}

/** An event to create (`US-A1`). */
export interface CreateEventInput {
  readonly zones: readonly Zone[];
  /** Bounds issuance; `null` leaves it unbounded (`REQ-EV-3`). */
  readonly capacity: number | null;
}

/** A write the ledger recorded. */
export interface Recorded {
  /**
   * The log cursor of the record the write produced. Once Kippu's derived copy
   * has read past it, the copy reflects the write (`NFR-11`).
   */
  readonly cursor: string;
}

/** An event the ledger recorded as created. */
export interface CreatedEvent extends Recorded {
  /** The `EventId`, derived by the Ticketto layer (`REQ-EV-9`). */
  readonly event: string;
}

/** An event, by its ledger identifier. */
export interface EventInput {
  /** The `EventId`, 64 lower-case hex characters. */
  readonly event: string;
}

/** A zone of an event, by its identifier. */
export interface ZoneInput extends EventInput {
  /** The `ZoneId`: 64 lower-case hex characters. */
  readonly zone: string;
}

/** A zone to add to an event (`REQ-ID-7`). */
export interface AddZoneInput extends EventInput {
  readonly zone: Zone;
}

/**
 * Canonical positions to add to a seated zone (`F-021` plan §5.3). A position is
 * a seat designation, such as `C-14`, matched exactly: `c14` is another position.
 */
export interface AddSeatPositionsInput extends ZoneInput {
  readonly positions: readonly string[];
}

/** A seated zone's canonical positions, in the order they were first uploaded. */
export interface SeatPositions {
  readonly event: string;
  readonly zone: string;
  readonly positions: readonly string[];
}

/**
 * A ticket class to define for an event (`US-B2`, `AC-B2.1`, `REQ-TC-1`–`REQ-TC-3`).
 * A class is Kippu data (`REQ-TC-2`): only its identifier, and the provenance,
 * policy and restrictions it determines, ever reach the ledger.
 */
export interface DefineClassInput extends EventInput {
  readonly name: string;
  readonly description: string | null;
  readonly provenance: Provenance;
  readonly policy: AttendancePolicy;
  /** Only a `Granted` class may set one (`REQ-TC-3`, `REQ-TK-4`). */
  readonly restrictions: TicketRestrictions;
  /** How many tickets the class may issue; `null` for no class quota (`REQ-TC-5`). */
  readonly quota: number | null;
}

/** Where a granted ticket is placed in its zone (§5.5). */
export type PlacementInput =
  /** A seat: one of the zone's canonical positions, matched exactly (`REQ-ID-3`). */
  | { readonly kind: "Seated"; readonly position: string }
  /** General admission: Kippu chooses a random 128-bit discriminator (`AD-12`). */
  | { readonly kind: "Unseated" };

/** A granted ticket to issue from a class (`US-B2`, `REQ-TC-4`). */
export interface IssueGrantedInput extends EventInput {
  /** The `ClassId` of a `Granted` class defined for the event. */
  readonly class: string;
  readonly zone: string;
  readonly placement: PlacementInput;
  /** The holder's `AccountId`, 64 lower-case hex characters (`INV-2`). */
  readonly holder: string;
}

/** A granted ticket the ledger recorded. */
export interface IssuedTicket extends Recorded {
  /** The `TicketId`, derived from event, zone and placement (`REQ-ID-1`). */
  readonly ticket: string;
}

/** A defined ticket class. */
export interface TicketClass {
  /** The opaque `ClassId` tickets carry: 32 random bytes, lower-case hex (`REQ-TC-2`). */
  readonly id: string;
  readonly event: string;
  readonly name: string;
  readonly description: string | null;
  readonly provenance: Provenance;
  readonly policy: AttendancePolicy;
  /** As tickets of the class carry them: `cannotTransfer` implies `cannotResale` (`REQ-TK-2`). */
  readonly restrictions: TicketRestrictions;
  readonly quota: number | null;
  /** ISO 8601. */
  readonly createdAt: string;
}

/**
 * What the events router reaches. Each call acts for one organiser, on behalf of
 * the request that caused it, so every ledger write it relays is attributable
 * (`NFR-7`). A refusal with a `SPEC.md` §10 code throws `SpecCodeError`.
 */
export interface Events {
  /**
   * Creates an event owned by the organiser's ledger account, `Active`, with
   * the given zones and capacity (`US-A1`, `AC-A1.1`), and links it to the
   * organiser in Kippu's store.
   */
  createEvent(
    organiserId: string,
    request: EventsRequest,
    input: CreateEventInput,
  ): Promise<CreatedEvent>;
  /** Adds a zone to an event the organiser owns; the ledger accepts it only while `Active`. */
  addZone(organiserId: string, request: EventsRequest, input: AddZoneInput): Promise<Recorded>;
  /**
   * Removes a zone from an event the organiser owns; the ledger refuses a zone in
   * which a ticket was issued (`ERR-ZoneInUse`). The zone's positions go with it.
   */
  removeZone(organiserId: string, request: EventsRequest, input: ZoneInput): Promise<Recorded>;
  /** Adds canonical positions to a seated zone of an event the organiser owns. */
  addSeatPositions(
    organiserId: string,
    request: EventsRequest,
    input: AddSeatPositionsInput,
  ): Promise<SeatPositions>;
  /** A seated zone's canonical positions. */
  seatPositions(organiserId: string, input: ZoneInput): Promise<SeatPositions>;
  /**
   * Issues a ticket from a granted class, free, with no payment record of any
   * kind (`REQ-TC-4`). It carries the class's id, policy and restrictions
   * (`REQ-TK-4`), and counts against the class quota (`REQ-TC-5`) and the
   * event's capacity. Refused with `ERR-UnknownClass` or `ERR-ClassQuotaExceeded`
   * by Kippu; with any other §10 code by the ledger.
   */
  issueGranted(
    organiserId: string,
    request: EventsRequest,
    input: IssueGrantedInput,
  ): Promise<IssuedTicket>;
  /** Defines a ticket class for an event the organiser owns. */
  defineClass(
    organiserId: string,
    request: EventsRequest,
    input: DefineClassInput,
  ): Promise<TicketClass>;
  /** The classes defined for an event the organiser owns, oldest first. */
  listClasses(organiserId: string, input: EventInput): Promise<readonly TicketClass[]>;
}
