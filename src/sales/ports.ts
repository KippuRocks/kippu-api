/**
 * Primary sales: checkout sessions and holds (`F-022`; `US-B4`).
 *
 * This module is imported by the tRPC context, whose type is published in
 * `@kippu/api`: it may import only modules that import nothing at runtime, and
 * names no SDK type. Identifiers cross it as lower-case hex strings.
 */

import type { Principal } from "../auth/ports.js";
import type { PlacementInput } from "../events/ports.js";

/** The request a call acts on behalf of: what Kippu attributes the checkout's steps to. */
export interface SalesRequest {
  readonly requestId: string;
  readonly principal: Principal;
}

/** What the buyer picked (`F-022` plan §5.1, step 1): an event, a zone, a class — and a seat. */
export interface BeginCheckoutInput {
  /** The `EventId`, 64 lower-case hex characters. */
  readonly event: string;
  /** The `ZoneId`, 64 lower-case hex characters. */
  readonly zone: string;
  /** The `ClassId` of a `Purchased` class defined for the event. */
  readonly class: string;
  /** A seat in a seated zone — one of its canonical positions — or general admission. */
  readonly placement: PlacementInput;
}

/** A checkout, by the token `beginCheckout` returned. */
export interface CheckoutTokenInput {
  readonly token: string;
}

/**
 * What Saifu needs to take over a checkout that has no holder account yet
 * (`AD-19` A): Ichiba passes it to Saifu — by universal link, or by QR code on
 * desktop — and Saifu, signed in as the holder, links the account to the
 * checkout with `sales.checkout.link`.
 */
export interface SaifuHandoff {
  /** The checkout's token. Whoever presents it with a holder session links their account. */
  readonly token: string;
}

/**
 * Whether the checkout has the holder account its ticket will be issued to
 * (`AC-B4.1`). A checkout proceeds only once it has one.
 */
export type CheckoutAccount =
  /** Linked: the checkout proceeds, and the ticket will be issued to `holder`. */
  | { readonly state: "linked"; readonly holder: string }
  /** No holder account yet: hand off to Saifu, and wait for the link. */
  | { readonly state: "handoff"; readonly handoff: SaifuHandoff };

/**
 * Where a checkout's hold stands (`REQ-HD-1`). `outstanding` counts against
 * capacity, class quota and seat; `lapsed` and `released` no longer do.
 */
export type HoldStatus = "outstanding" | "lapsed" | "released";

/** A checkout's hold on the issuance of its ticket: a Kippu fact, with no holder (`REQ-HD-2`). */
export interface CheckoutHold {
  readonly status: HoldStatus;
  /** ISO 8601. When an outstanding hold lapses, unless it is confirmed first. */
  readonly expiresAt: string;
  /** Whether the lifetime was extended, once, when payment started (`F-022` plan §5.2). */
  readonly extended: boolean;
}

/** A checkout session. */
export interface Checkout {
  readonly event: string;
  readonly zone: string;
  readonly class: string;
  readonly placement: PlacementInput;
  readonly account: CheckoutAccount;
  /** The checkout's hold, once placed; `null` before. */
  readonly hold: CheckoutHold | null;
  /** ISO 8601. */
  readonly createdAt: string;
}

/**
 * Why a hold was refused — before any payment step (`AC-B4.4`):
 * - `sold-out`: outstanding holds and issued tickets fill the event's capacity (`INV-4`);
 * - `class-sold-out`: they fill the class's quota (`REQ-TC-5`);
 * - `seat-taken`: the seat is issued, being issued, or held by another checkout
 *   (`REQ-HD-3`, `AC-B5.2`).
 */
export type HoldRefusal = "sold-out" | "class-sold-out" | "seat-taken";

/** The outcome of placing a checkout's hold. A refusal is an answer, not an error. */
export type HoldOutcome =
  | { readonly outcome: "held"; readonly checkout: Checkout }
  | { readonly outcome: "refused"; readonly reason: HoldRefusal };

/** A checkout just begun, with the token that names it. The token is shown exactly once. */
export interface BegunCheckout {
  readonly token: string;
  readonly checkout: Checkout;
}

export type CheckoutFailure =
  /** No checkout has this token. */
  | "unknown-checkout"
  /** The checkout is already linked to another holder account. */
  | "linked-to-another-account"
  /** The checkout has no holder account yet: hand off to Saifu first (`AC-B4.1`). */
  | "account-required"
  /** The checkout's hold lapsed or was released: begin a new checkout. */
  | "hold-ended";

export class CheckoutError extends Error {
  readonly failure: CheckoutFailure;

  constructor(failure: CheckoutFailure, message: string = failure) {
    super(message);
    this.name = "CheckoutError";
    this.failure = failure;
  }
}

/**
 * What the sales router reaches. A refusal with a `SPEC.md` §10 code throws
 * `SpecCodeError`; one §10 has no code for throws `RefusedRequest` or
 * `CheckoutError`.
 */
export interface Sales {
  /**
   * Begins a checkout for a ticket of a `Purchased` class. Refused before
   * anything is held when the event is not on sale, the class is unknown or not
   * `Purchased`, or the placement does not fit the zone. A holder's session links
   * the checkout to its account at once; any other caller gets a Saifu handoff.
   */
  beginCheckout(request: SalesRequest, input: BeginCheckoutInput): Promise<BegunCheckout>;
  /** The checkout `token` names. */
  checkout(token: string): Promise<Checkout>;
  /**
   * Links the holder's account to the checkout `token` names (`AD-19` A). Linking
   * the same account again changes nothing; another account is refused. Only a
   * holder principal links.
   */
  linkCheckout(request: SalesRequest, token: string): Promise<Checkout>;
  /**
   * Places the checkout's hold (`REQ-HD-1`, `REQ-HD-3`): in one transaction, it is
   * counted against the event's capacity, the class's quota and, in a seated zone,
   * the seat. Refused — before any payment — when any is exhausted (`AC-B4.4`).
   * The checkout must have a holder account. Asking again while the hold is
   * outstanding answers with the same hold; once it has lapsed or been released,
   * the checkout is over.
   */
  hold(request: SalesRequest, token: string): Promise<HoldOutcome>;
}
