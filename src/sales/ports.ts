/**
 * Primary sales: checkout sessions and holds (`F-022`; `US-B4`).
 *
 * This module is imported by the tRPC context, whose type is published in
 * `@kippu/api`: it may import only modules that import nothing at runtime, and
 * names no SDK type. Identifiers cross it as lower-case hex strings.
 */

import type { Principal } from "../auth/ports.js";
import type { PlacementInput, SaleAsset } from "../events/ports.js";

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

/** Reading a checkout, optionally waiting for its ticket to become visible. */
export interface GetCheckoutInput extends CheckoutTokenInput {
  /**
   * Once the sale is issued, wait up to this many ms (at most 10,000) for Kippu's
   * copy to reach the issuance receipt before answering (`ticketVisible`).
   * Answers at once when the sale is not issued yet, or already visible.
   */
  readonly waitForTicketMs?: number;
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
 * capacity, class quota and seat; so does `issuing` — paid, and being issued,
 * no longer lapsing — and `confirmed`, whose ticket is issued. `lapsed` and
 * `released` no longer count.
 */
export type HoldStatus = "outstanding" | "issuing" | "confirmed" | "lapsed" | "released";

/** A checkout's hold on the issuance of its ticket: a Kippu fact, with no holder (`REQ-HD-2`). */
export interface CheckoutHold {
  readonly status: HoldStatus;
  /** ISO 8601. When an outstanding hold lapses, unless it is confirmed first. */
  readonly expiresAt: string;
  /** Whether the lifetime was extended, once, when payment started (`F-022` plan §5.2). */
  readonly extended: boolean;
  /**
   * The sale asset and price the hold was placed at — what paying for it charges,
   * whatever the class's price is now (`F-021` plan, "Prices"). `null` for holds
   * placed before prices existed.
   */
  readonly asset: string | null;
  /** In the asset's minor units. */
  readonly price: number | null;
}

/** A hosted checkout at the payment provider, created for the hold (`F-022` plan §5.4). */
export interface CheckoutPayment {
  /** `open`: the buyer can pay at `url`; `paid`; `expired` or `cancelled`: unpaid, and over. */
  readonly status: "open" | "paid" | "expired" | "cancelled";
  /** The provider's hosted page: Ichiba redirects the buyer there. */
  readonly url: string;
  /** In the event's sale asset's minor units. */
  readonly amount: number;
  readonly asset: string;
  /** ISO 8601: the hold's expiry, extended once when the checkout was created. */
  readonly expiresAt: string;
}

/** The ticket a verified payment is issuing. */
export interface CheckoutSale {
  /**
   * `issuing`: being issued; `issued`: the ledger recorded the ticket; `rejected`:
   * it was not issued, and a refund is due; `failed`: no verdict came back yet.
   */
  readonly status: "issuing" | "issued" | "rejected" | "failed";
  /** The `TicketId`, once assembled. */
  readonly ticket: string | null;
  /** The issuance receipt's log cursor, once issued: wait for the derived copy to reach it. */
  readonly cursor: string | null;
}

/** A refund entitlement (`F-022` plan §5.1 step 7, §5.5). */
export interface CheckoutRefund {
  readonly amount: number;
  readonly asset: string;
  /**
   * `issuance-rejected`: the ticket was not issued; `place-gone`: the payment
   * landed after the hold ended and the place was taken; `amount-mismatch`: the
   * provider took another amount than the price; `event-closed`: the hold was
   * released because the event is being sealed or cancelled (`REQ-HD-4`);
   * `event-cancelled`: the ticket's event was cancelled (`AC-A5.5`), and the refund
   * is owed to its original purchaser.
   */
  readonly reason:
    | "issuance-rejected"
    | "place-gone"
    | "amount-mismatch"
    | "event-closed"
    | "event-cancelled";
}

/** Paying for a checkout's hold: the checkout page's token, and Ichiba's return URLs. */
export interface PayCheckoutInput extends CheckoutTokenInput {
  /** Where the provider's page sends the buyer after paying. */
  readonly successUrl: string;
  /** Where the provider's page sends the buyer who gives up. */
  readonly cancelUrl: string;
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
  /** The latest hosted checkout created for the hold, as Kippu last read it; `null` before paying. */
  readonly payment: CheckoutPayment | null;
  /** The issuance a verified payment started (`T-022-04`); `null` before one. */
  readonly sale: CheckoutSale | null;
  /** What Kippu owes the buyer, who paid and got no ticket (`F-022` plan §5.5); `null` when nothing. */
  readonly refund: CheckoutRefund | null;
  /**
   * Whether Kippu's copy of the ledger has reached the sale's issuance receipt
   * (`NFR-11`), so Saifu shows the ticket: only then may Ichiba say the ticket is
   * in Saifu (`F-022` plan §5.1, confirmation freshness). `false` until issued.
   */
  readonly ticketVisible: boolean;
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
  | "hold-ended"
  /** The checkout has no hold to pay for yet. */
  | "hold-required"
  /** The checkout's hold is already paid for. */
  | "already-paid"
  /** The event is being sealed or cancelled: its sales are closed (`REQ-HD-4`). */
  | "sales-closed";

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
  /**
   * The checkout `token` names. With `waitForTicketMs`, an issued sale's ticket is
   * waited for, that long at most (up to 10 s), to be visible in Kippu's copy.
   */
  checkout(token: string, options?: { readonly waitForTicketMs?: number }): Promise<Checkout>;
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
  /**
   * Starts paying for the checkout's outstanding hold (`F-022` plan §5.1 step 4):
   * creates the provider's hosted checkout for the hold's price, expiring with the
   * hold — extended once, now — or answers with the open one. A cancelled or
   * expired one is replaced while the hold lives. Ichiba redirects to `url`.
   */
  pay(request: SalesRequest, input: PayCheckoutInput): Promise<CheckoutPayment>;
  /**
   * The buyer gives up (`AC-B4.3`): the open hosted checkout is cancelled and the
   * hold released. A payment that landed first is honoured instead.
   */
  cancel(request: SalesRequest, token: string): Promise<Checkout>;
  /**
   * A payment provider's webhook: its raw body and signature. Answers `false`
   * when the signature does not verify. A verified webhook only prompts Kippu to
   * retrieve the checkouts it names; a payment is trusted once retrieved `paid`
   * for the hold's price (plan §5.4).
   */
  paymentWebhook(
    requestId: string,
    rawBody: string,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<boolean>;
  /**
   * The event's public sale inventory (`T-022-10`): its `Purchased` classes with
   * availability counting holds, and the free seats of each seated zone.
   * `ERR-EventNotFound` when the ledger has no such event.
   */
  inventory(event: string): Promise<SaleInventory>;
}

/** An event's inventory, by its ledger identifier. */
export interface SaleInventoryInput {
  /** The `EventId`, 64 lower-case hex characters. */
  readonly event: string;
}

/** A `Purchased` class on sale, and how many more of its tickets can be held (`T-022-10`). */
export interface ClassOnSale {
  /** The opaque `ClassId` (`REQ-TC-2`). */
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /**
   * The price a hold placed now is charged: a positive integer in the event's
   * sale asset's minor units (`F-021` plan, "Prices"). Kippu's; never on the ledger.
   */
  readonly price: number;
  /** The attendance policy its tickets carry. Times are Unix milliseconds. */
  readonly policy:
    | { readonly kind: "Single" }
    | { readonly kind: "Multiple"; readonly max: number; readonly until: number | null }
    | { readonly kind: "Unlimited"; readonly until: number | null };
  /**
   * How many more of the class's tickets can be held now: the lesser of the
   * event's and the class quota's room, each counting outstanding holds
   * (`REQ-HD-3`). `null` when neither bounds it.
   */
  readonly available: number | null;
}

/** A zone of the event, and — in a seated zone — the seats that can be picked. */
export type ZoneOnSale =
  | { readonly id: string; readonly kind: "Unseated" }
  | {
      readonly id: string;
      readonly kind: "Seated";
      /**
       * The zone's canonical positions neither issued, being issued, nor held by a
       * checkout, in the order the organiser uploaded them (`US-B5`, `REQ-HD-3`).
       */
      readonly freeSeats: readonly string[];
    };

/**
 * What Ichiba offers of an event (`T-022-10`; `REQ-MP-7`): public, with no
 * session. It is a snapshot for display: a hold, placed atomically, is what
 * decides (`AC-B4.4`).
 */
export interface SaleInventory {
  readonly event: string;
  /**
   * Whether the event is on sale: `Active` on the ledger (`REQ-EV-8`), with a sale
   * asset chosen and every `Purchased` class priced. Nothing is offered otherwise.
   */
  readonly onSale: boolean;
  /** What the event's prices are in: `COPM/2` or `DUSD/6`; `null` until the organiser chooses. */
  readonly asset: SaleAsset | null;
  /**
   * How many more tickets of any class can be held: capacity less issued
   * tickets and outstanding holds (`INV-4`). `null` when unbounded.
   */
  readonly available: number | null;
  /** The event's `Purchased` classes, in the order they were defined; empty when not on sale. */
  readonly classes: readonly ClassOnSale[];
  /** The event's zones, in ledger order; empty when not on sale. */
  readonly zones: readonly ZoneOnSale[];
}
