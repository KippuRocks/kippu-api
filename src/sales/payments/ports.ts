/**
 * The payment provider, as checkout uses it (`T-022-01`; `F-022` plan §5.4).
 *
 * V0 takes payment through a provider's **hosted checkout**: Kippu creates a
 * checkout for a hold, the buyer is redirected to the provider's page and pays
 * there, and the provider notifies Kippu with a signed webhook. Kippu and Ichiba
 * never see payment details, and Kippu passes no payer details (plan §5.4). The
 * provider has no authorise/capture split and no refund call: refunds are
 * entitlements Kippu records and disburses separately (plan §5.5).
 *
 * Nothing here reaches the ledger: a price is Kippu's concern alone (`AC-B4.2`).
 */

/** The payment methods a hosted checkout offers: card and PSE, never cash (plan §5.4). */
export const PAYMENT_METHODS = ["card", "pse"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** A hosted checkout to create for one hold. */
export interface CreateHostedCheckout {
  /** The hold the payment is for. The provider carries it as metadata. */
  readonly holdId: string;
  /**
   * What the buyer is shown they are paying for, such as the class's name. Never
   * the buyer's personal data.
   */
  readonly description: string;
  /** The amount, in the asset's smallest unit: a non-negative safe integer. */
  readonly amount: number;
  /** The asset, as `SYMBOL/DECIMALS`, such as `COP/2`. */
  readonly asset: string;
  /** When the checkout stops accepting payment: the hold's expiry (plan §5.1, step 4). */
  readonly expiresAt: Date;
  /** Where the provider's page sends the buyer after paying. */
  readonly successUrl: string;
  /** Where the provider's page sends the buyer who gives up. */
  readonly cancelUrl: string;
}

/**
 * Where a hosted checkout stands, as the provider reports it:
 * - `open`: created, not yet paid;
 * - `paid`: the provider has taken the payment;
 * - `expired`: it passed its expiry unpaid;
 * - `cancelled`: it was cancelled unpaid.
 */
export type HostedCheckoutStatus = "open" | "paid" | "expired" | "cancelled";

/** A hosted checkout, as the provider reports it. */
export interface HostedCheckout {
  /** The provider's identifier: what `retrieve` and `cancel` take. */
  readonly id: string;
  /** The provider's page the buyer is redirected to. */
  readonly url: string;
  readonly status: HostedCheckoutStatus;
  /** The total the provider charges, in the asset's smallest unit. */
  readonly amount: number;
  readonly asset: string;
  /** The hold named in the checkout's metadata, or `null` when it names none. */
  readonly holdId: string | null;
  readonly expiresAt: Date | null;
}

/**
 * A webhook whose signature verified. Its content is still only a hint: a
 * payment is trusted once the checkout, retrieved from the provider, is `paid`
 * for the expected amount and hold (plan §5.4).
 */
export interface VerifiedWebhook {
  /** Provider checkout identifiers the payload names. */
  readonly checkoutIds: readonly string[];
  /** Holds the payload's metadata names. */
  readonly holdIds: readonly string[];
}

export class PaymentProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PaymentProviderError";
  }
}

/** A hosted-checkout payment provider (plan §5.4). */
export interface PaymentProvider {
  /** Creates a hosted checkout for a hold, offering `PAYMENT_METHODS` only. */
  createCheckout(input: CreateHostedCheckout): Promise<HostedCheckout>;
  /** The checkout as the provider reports it now. */
  retrieve(id: string): Promise<HostedCheckout>;
  /**
   * Cancels an unpaid checkout, so it can no longer be paid. A checkout already
   * paid is not cancelled: the answer reports it `paid`.
   */
  cancel(id: string): Promise<HostedCheckout>;
  /**
   * Verifies a webhook's signature over its raw body, exactly as received.
   * `null` when it does not verify.
   */
  verifyWebhook(rawBody: string, signature: string | undefined): VerifiedWebhook | null;
}
