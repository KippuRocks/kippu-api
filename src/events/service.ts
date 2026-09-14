import type { OrganiserAuthority } from "../authority/authority.js";
import { type Classes, createClasses } from "../classes/classes.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import { createEventWith } from "./create-event.js";
import type { Events } from "./ports.js";
import { createZones, type Zones } from "./zones.js";

export interface EventsOptions {
  readonly store: Store;
  /** Organisers' authority over their events (`T-021-01`). */
  readonly authority: OrganiserAuthority;
  /** The SDK, from `makeTicketto` (`T-020-08`). */
  readonly ledger: KippuTicketto;
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
}

/** The `F-021` services behind the events router. */
export function createEvents(
  options: EventsOptions,
): Events & { readonly classes: Classes; readonly zones: Zones } {
  const classes = createClasses(options);
  const zones = createZones(options);
  return {
    classes,
    zones,
    createEvent: createEventWith(options),
    addZone: (organiserId, request, input) => zones.addZone(organiserId, request, input),
    removeZone: (organiserId, request, input) => zones.removeZone(organiserId, request, input),
    addSeatPositions: (organiserId, request, input) =>
      zones.addSeatPositions(organiserId, request, input),
    seatPositions: (organiserId, input) => zones.seatPositions(organiserId, input),
    defineClass: (organiserId, request, input) => classes.define(organiserId, request, input),
    listClasses: (organiserId, input) => classes.list(organiserId, input),
  };
}
