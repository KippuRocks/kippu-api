import type { OrganiserAuthority } from "../authority/authority.js";
import type { Classes } from "../classes/classes.js";
import type { Freshness } from "../derived/freshness.js";
import type { SeatAllocation } from "../events/seats.js";
import type { Zones } from "../events/zones.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import { createCheckouts } from "./checkout.js";
import { createHolds, type Holds } from "./holds.js";
import { createInventory } from "./inventory.js";
import { createPayments, type Payments } from "./payment.js";
import type { PaymentProvider } from "./payments/ports.js";
import type { Sales } from "./ports.js";

export interface SalesOptions {
  readonly store: Store;
  /** The SDK, from `makeTicketto` (`T-020-08`). */
  readonly ledger: KippuTicketto;
  /** `F-021`'s organiser authority, which issues purchased tickets (`T-021-01`). */
  readonly authority: Pick<OrganiserAuthority, "relay">;
  /** `F-021`'s ticket classes. */
  readonly classes: Pick<Classes, "find">;
  /** `F-021`'s zones, for canonical seat positions (`REQ-ID-3`). */
  readonly zones: Pick<Zones, "canonicalPosition">;
  /** `F-021`'s seated double-allocation pre-check (`T-021-06`). */
  readonly seats: Pick<SeatAllocation, "lock" | "assertFree" | "ticketOf">;
  /** How far Kippu's copy has read the ledger (`F-025`), for checkout's `ticketVisible`. */
  readonly freshness: Pick<Freshness, "waitFor">;
  /** The payment provider's hosted checkout (`T-022-01`). */
  readonly provider: PaymentProvider;
  /** The absolute URL of kippu-api's payment webhook route, for the provider to call. */
  readonly webhookUrl: string;
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
  /** Receives failures of work no caller awaits: webhooks' and sweeps'. */
  readonly onError?: (error: unknown) => void;
}

/** The `F-022` services behind the sales router, with the holds and payments they use. */
export function createSales(
  options: SalesOptions,
): Sales & { readonly holds: Holds; readonly payments: Payments } {
  const holds = createHolds(options);
  const payments = createPayments(options);
  const { inventory } = createInventory(options);
  const checkouts = createCheckouts({ ...options, holds });
  return {
    ...checkouts,
    inventory,
    pay: (request, input) => payments.pay(request, input),
    async cancel(request, token) {
      await payments.cancel(request, token);
      return checkouts.checkout(token);
    },
    paymentWebhook: (requestId, rawBody, headers) =>
      payments.paymentWebhook(requestId, rawBody, headers),
    holds,
    payments,
  };
}
