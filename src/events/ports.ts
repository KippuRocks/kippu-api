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

/**
 * What an event's primary sales are priced in (`F-021` plan, "Prices"): `COPM/2`
 * or `DUSD/6`, as the payment provider's checkout supports. Kippu's, never the
 * ledger's (`AC-B4.2`).
 */
export type SaleAsset = "COPM/2" | "DUSD/6";

/** An event to create (`US-A1`). */
export interface CreateEventInput {
  readonly zones: readonly Zone[];
  /** Bounds issuance; `null` leaves it unbounded (`REQ-EV-3`). */
  readonly capacity: number | null;
  /** The event's sale asset, if chosen now; it can be set later (`events.setSaleAsset`). */
  readonly saleAsset?: SaleAsset | null;
}

/** An event's sale asset to set. */
export interface SetSaleAssetInput {
  readonly event: string;
  readonly asset: SaleAsset;
}

/** An event's sale asset, and whether it can still change. */
export interface EventSaleAsset {
  readonly event: string;
  /** `null` until the organiser chooses one; nothing of the event can be held before. */
  readonly asset: SaleAsset | null;
  /** `true` once the event has had a hold or a sale: the asset can no longer change. */
  readonly fixed: boolean;
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
  /**
   * A `Purchased` class's price: a positive integer in the event's sale asset's
   * minor units, required. A `Granted` class has none (`null`, or left out).
   */
  readonly price?: number | null;
}

/** A `Purchased` class's new price. It applies to holds placed from now on. */
export interface SetClassPriceInput extends EventInput {
  readonly class: string;
  /** A positive integer in the event's sale asset's minor units. */
  readonly price: number;
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

/**
 * An invitation to create (`T-021-12`; `F-021` plan §5.6): a granted ticket of a
 * class, at a placement, waiting for a guest to link a holder account in Saifu
 * and redeem it.
 */
export interface CreateInvitationInput extends EventInput {
  /** The `ClassId` of a `Granted` class defined for the event. */
  readonly class: string;
  readonly zone: string;
  /** Checked when the invitation is created, and again when its ticket is issued. */
  readonly placement: PlacementInput;
  /**
   * Who the invitation is for, as the organiser writes it — a name, say. Kept in
   * Kippu and shown only to the organiser; it never reaches the ledger (`NFR-6`).
   */
  readonly guest: string | null;
}

/**
 * Where an invitation stands. `redeeming` while its ticket is being issued;
 * `failed` when issuance ended with no ledger verdict, since the ticket may exist.
 */
export type InvitationStatus = "open" | "redeeming" | "redeemed" | "failed";

/** An invitation, as its organiser sees it. The token is never shown again. */
export interface Invitation {
  readonly id: string;
  readonly event: string;
  readonly class: string;
  readonly zone: string;
  readonly placement: PlacementInput;
  readonly guest: string | null;
  readonly status: InvitationStatus;
  /** The holder account that redeemed it, once one has. */
  readonly holder: string | null;
  /** The `TicketId` issued, once redeemed. */
  readonly ticket: string | null;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601, once redeemed. */
  readonly redeemedAt: string | null;
}

/** A created invitation, with its token: shown this once, and stored only as a hash. */
export interface CreatedInvitation {
  readonly invitation: Invitation;
  /** The unguessable token the guest's link carries: 32 random bytes, base64url. */
  readonly token: string;
}

/** An event's invitations, optionally those of one class. */
export interface ListInvitationsInput extends EventInput {
  readonly class: string | null;
}

/** A token to redeem. */
export interface RedeemInvitationInput {
  readonly token: string;
}

/** A redeemed invitation: the ticket the ledger recorded for the linked holder account. */
export interface RedeemedInvitation extends IssuedTicket {
  readonly event: string;
  readonly class: string;
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
  /** A `Purchased` class's price, in the sale asset's minor units; `null` for a `Granted` class. */
  readonly price: number | null;
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
  /**
   * Sets the sale asset of an event the organiser owns. Refused once the event
   * has had a hold or a sale, unless it names the asset already set.
   */
  setSaleAsset(
    organiserId: string,
    request: EventsRequest,
    input: SetSaleAssetInput,
  ): Promise<EventSaleAsset>;
  /** The sale asset of an event the organiser owns. */
  saleAsset(organiserId: string, input: EventInput): Promise<EventSaleAsset>;
  /** Sets a `Purchased` class's price, for holds placed from now on. */
  setClassPrice(
    organiserId: string,
    request: EventsRequest,
    input: SetClassPriceInput,
  ): Promise<TicketClass>;
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
  /** Creates an invitation to a granted class of an event the organiser owns. */
  createInvitation(
    organiserId: string,
    request: EventsRequest,
    input: CreateInvitationInput,
  ): Promise<CreatedInvitation>;
  /** An event's invitations, oldest first. */
  listInvitations(organiserId: string, input: ListInvitationsInput): Promise<readonly Invitation[]>;
  /**
   * Redeems an invitation for the holder account `holder` a holder session is
   * linked to: the class's ticket is issued to it, once, under the organiser's
   * authority. An unknown token, and one already redeemed, are refused.
   */
  redeemInvitation(
    holder: string,
    request: EventsRequest,
    input: RedeemInvitationInput,
  ): Promise<RedeemedInvitation>;
  /** Defines a ticket class for an event the organiser owns. */
  defineClass(
    organiserId: string,
    request: EventsRequest,
    input: DefineClassInput,
  ): Promise<TicketClass>;
  /** The classes defined for an event the organiser owns, oldest first. */
  listClasses(organiserId: string, input: EventInput): Promise<readonly TicketClass[]>;
}
