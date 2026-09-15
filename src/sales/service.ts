import type { Classes } from "../classes/classes.js";
import type { Zones } from "../events/zones.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import { createCheckouts } from "./checkout.js";
import type { Sales } from "./ports.js";

export interface SalesOptions {
  readonly store: Store;
  /** The SDK, from `makeTicketto` (`T-020-08`). */
  readonly ledger: KippuTicketto;
  /** `F-021`'s ticket classes. */
  readonly classes: Pick<Classes, "find">;
  /** `F-021`'s zones, for canonical seat positions (`REQ-ID-3`). */
  readonly zones: Pick<Zones, "canonicalPosition">;
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
}

/** The `F-022` services behind the sales router. */
export function createSales(options: SalesOptions): Sales {
  return createCheckouts(options);
}
