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

/** Checkout (`F-022`): what Ichiba and Saifu exchange over a checkout and its Saifu handoff. */
export type {
  BeginCheckoutInput,
  BegunCheckout,
  Checkout,
  CheckoutAccount,
  CheckoutTokenInput,
  SaifuHandoff,
} from "../../../src/sales/ports.js";
export type { AppRouter } from "../../../src/trpc/router.js";
