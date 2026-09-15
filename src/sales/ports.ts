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

/** A checkout, by the token `beginCheckout` returned: the checkout page's own. */
export interface CheckoutTokenInput {
  readonly token: string;
}

/** A checkout's handoff, by the handoff token Saifu was given. */
export interface HandoffTokenInput {
  readonly handoffToken: string;
}

/** The buyer's confirmation, on the checkout page, that Saifu shows the same pairing code. */
export interface ConfirmLinkInput extends CheckoutTokenInput {
  /** The pairing code the page showed. */
  readonly pairingCode: string;
}

/**
 * What Saifu needs to take over a checkout that has no holder account yet
 * (`AD-19` A): Ichiba passes it to Saifu — by universal link, or by QR code on
 * desktop — and Saifu, signed in as the holder, links the account to the
 * checkout with `sales.checkout.link`.
 *
 * The handoff token is not the checkout's token. It can be seen, so it only
 * links: confirming the link, holding and paying need the checkout page's token
 * (`F-022` plan §5.1, handoff pairing). Discarding a link replaces it.
 */
export interface SaifuHandoff {
  readonly handoffToken: string;
}

/**
 * Whether the checkout has the holder account its ticket will be issued to
 * (`AC-B4.1`). A checkout holds and pays only once its link is confirmed.
 */
export type CheckoutAccount =
  /** No holder account yet: hand off to Saifu, and wait for the link. */
  | { readonly state: "handoff"; readonly handoff: SaifuHandoff }
  /**
   * Saifu linked an account, not yet confirmed. The page shows `pairingCode`,
   * Saifu shows its own; the buyer confirms they match (`confirmLink`), or
   * discards the link (`discardLink`).
   */
  | { readonly state: "pairing"; readonly pairingCode: string }
  /** Linked and confirmed: the checkout proceeds, and the ticket will be issued to `holder`. */
  | { readonly state: "linked"; readonly holder: string };

/** What Saifu shows once it has linked the holder's account: what is being bought, and the pairing code. */
export interface HandoffLink {
  readonly event: string;
  readonly zone: string;
  readonly class: string;
  readonly placement: PlacementInput;
  /** The code the checkout page shows too. */
  readonly pairingCode: string;
}

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
  /**
   * ISO 8601. When the checkout expires unless a hold is placed first; `null`
   * once one is, since a hold carries its own lifetime.
   */
  readonly expiresAt: string | null;
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
  /** No checkout has this token, or it expired with no hold. */
  | "unknown-checkout"
  /** The checkout's link is not confirmed on the checkout page yet. */
  | "link-unconfirmed"
  /** The checkout has no unconfirmed link to confirm or discard. */
  | "not-pairing"
  /** The pairing code is not the one the checkout shows. */
  | "pairing-code-mismatch"
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
   * Links the holder's account to the checkout `handoffToken` hands off
   * (`AD-19` A), unconfirmed, and answers with the pairing code. Linking the same
   * account again changes nothing; another account is refused. Only a holder
   * principal links.
   */
  linkCheckout(request: SalesRequest, handoffToken: string): Promise<HandoffLink>;
  /** Confirms the checkout's link, provided `pairingCode` is the one it shows. */
  confirmLink(request: SalesRequest, token: string, pairingCode: string): Promise<Checkout>;
  /**
   * Discards the checkout's unconfirmed link, and replaces the handoff token: the
   * one that was seen links nothing any more.
   */
  discardLink(request: SalesRequest, token: string): Promise<Checkout>;
  /**
   * Places the checkout's hold (`REQ-HD-1`, `REQ-HD-3`): in one transaction, it is
   * counted against the event's capacity, the class's quota and, in a seated zone,
   * the seat. Refused — before any payment — when any is exhausted (`AC-B4.4`).
   * The checkout's link must be confirmed. Asking again while the hold is
   * outstanding answers with the same hold; once it has lapsed or been released,
   * the checkout is over.
   */
  hold(request: SalesRequest, token: string): Promise<HoldOutcome>;
}
