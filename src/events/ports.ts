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
  /** Defines a ticket class for an event the organiser owns. */
  defineClass(
    organiserId: string,
    request: EventsRequest,
    input: DefineClassInput,
  ): Promise<TicketClass>;
  /** The classes defined for an event the organiser owns, oldest first. */
  listClasses(organiserId: string, input: EventInput): Promise<readonly TicketClass[]>;
}
