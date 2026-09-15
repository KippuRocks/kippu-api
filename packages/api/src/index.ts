/**
 * `@kippu/api` — the `C5` contract.
 *
 * Exports only types. Clients depend on this package by version and compile
 * their tRPC client against `AppRouter`; nothing of the server's
 * implementation ships in it.
 *
 * A failed call carries the `SPEC.md` §10 code, when there is one, verbatim in
 * `error.data.errorCode`.
 */

/** Events and classes (`F-021`): sale assets and prices, for Ibento and Ichiba. */
export type {
  CreateEventInput,
  DefineClassInput,
  EventSaleAsset,
  SaleAsset,
  SetClassPriceInput,
  SetSaleAssetInput,
  TicketClass,
} from "../../../src/events/ports.js";
/** Checkout (`F-022`): what Ichiba and Saifu exchange over a checkout, its Saifu handoff and its hold. */
export type {
  BeginCheckoutInput,
  BegunCheckout,
  Checkout,
  CheckoutAccount,
  CheckoutHold,
  CheckoutPayment,
  CheckoutRefund,
  CheckoutSale,
  CheckoutTokenInput,
  ClassOnSale,
  ConfirmLinkInput,
  HandoffLink,
  HandoffTokenInput,
  HoldOutcome,
  HoldRefusal,
  HoldStatus,
  PayCheckoutInput,
  SaifuHandoff,
  SaleInventory,
  SaleInventoryInput,
  ZoneOnSale,
} from "../../../src/sales/ports.js";
export type { AppRouter } from "../../../src/trpc/router.js";
