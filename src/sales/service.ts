import type { Classes } from "../classes/classes.js";
import type { SeatAllocation } from "../events/seats.js";
import type { Zones } from "../events/zones.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import { createCheckouts } from "./checkout.js";
import { createHolds, type Holds } from "./holds.js";
import type { Sales } from "./ports.js";

export interface SalesOptions {
  readonly store: Store;
  /** The SDK, from `makeTicketto` (`T-020-08`). */
  readonly ledger: KippuTicketto;
  /** `F-021`'s ticket classes. */
  readonly classes: Pick<Classes, "find">;
  /** `F-021`'s zones, for canonical seat positions (`REQ-ID-3`). */
  readonly zones: Pick<Zones, "canonicalPosition">;
  /** `F-021`'s seated double-allocation pre-check (`T-021-06`). */
  readonly seats: Pick<SeatAllocation, "lock" | "assertFree">;
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
}

/** The `F-022` services behind the sales router, and the holds they place. */
export function createSales(options: SalesOptions): Sales & { readonly holds: Holds } {
  const holds = createHolds(options);
  return { ...createCheckouts({ ...options, holds }), holds };
}
