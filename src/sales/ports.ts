/**
 * Primary sales: checkout sessions (`F-022`; `US-B4`).
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

/** A checkout session. */
export interface Checkout {
  readonly event: string;
  readonly zone: string;
  readonly class: string;
  readonly placement: PlacementInput;
  readonly account: CheckoutAccount;
  /** ISO 8601. */
  readonly createdAt: string;
}

/** A checkout just begun, with the token that names it. The token is shown exactly once. */
export interface BegunCheckout {
  readonly token: string;
  readonly checkout: Checkout;
}

export type CheckoutFailure =
  /** No checkout has this token. */
  | "unknown-checkout"
  /** The checkout is already linked to another holder account. */
  | "linked-to-another-account";

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
}
