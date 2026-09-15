import type { OrganiserAuthority } from "../authority/authority.js";
import { type Classes, createClasses } from "../classes/classes.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { OrganiserSaleActions } from "../sales/organiser-actions.js";
import type { Store } from "../store/store.js";
import { type Capacity, createCapacity } from "./capacity.js";
import { createEventWith } from "./create-event.js";
import { createFinishSchedules, type FinishSchedules } from "./finish-schedule.js";
import { createInvitations, type Invitations } from "./invitations.js";
import { issueGrantedWith } from "./issuance.js";
import { createPassWindows, type PassWindows } from "./pass-window.js";
import type { Events } from "./ports.js";
import { removeRestrictionWith } from "./restrictions.js";
import { createSaleAssets, type SaleAssets } from "./sale-assets.js";
import { createSeatAllocation, type SeatAllocation } from "./seats.js";
import { createStatusTransitions, type StatusTransitions } from "./status.js";
import { createZones, type Zones } from "./zones.js";

export interface EventsOptions {
  readonly store: Store;
  /** Organisers' authority over their events (`T-021-01`). */
  readonly authority: OrganiserAuthority;
  /** The SDK, from `makeTicketto` (`T-020-08`). */
  readonly ledger: KippuTicketto;
  /**
   * `F-022`'s organiser sale actions, resolved when an organiser action runs:
   * sales are created after events (`T-022-05`).
   */
  readonly saleActions: () => OrganiserSaleActions;
  /** The ledger's maximum pass window, in milliseconds, from the rules configuration (`ledgerLimits`). */
  readonly maxPassWindow: number;
  /** The public origin metadata locators name (`AD-22`); defaults to `https://meta.kippu.rocks`. */
  readonly metadataPublicUrl?: string;
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
  /** Receives failures no caller awaits: the finish scheduler's. */
  readonly onError?: (error: unknown) => void;
}

/** The `F-021` services behind the events router. */
export function createEvents(options: EventsOptions): Events & {
  readonly classes: Classes;
  readonly zones: Zones;
  readonly invitations: Invitations;
  /** The seated double-allocation pre-check, for every way of allocating a seat (`F-022` holds). */
  readonly seats: SeatAllocation;
  readonly saleAssets: SaleAssets;
  readonly passWindows: PassWindows;
  readonly capacity: Capacity;
  readonly status: StatusTransitions;
  readonly finishSchedules: FinishSchedules;
} {
  const classes = createClasses(options);
  const zones = createZones(options);
  const seats = createSeatAllocation(options);
  const saleAssets = createSaleAssets(options);
  const passWindows = createPassWindows(options);
  const capacity = createCapacity(options);
  const status = createStatusTransitions(options);
  const finishSchedules = createFinishSchedules({ ...options, status });
  const issueGranted = issueGrantedWith({ ...options, classes, zones, seats });
  const invitations = createInvitations({ ...options, classes, zones, issueGranted });
  return {
    classes,
    zones,
    invitations,
    seats,
    saleAssets,
    passWindows,
    capacity,
    status,
    finishSchedules,
    seal: (organiserId, request, input) => status.seal(organiserId, request, input.event),
    cancel: (organiserId, request, input) => status.cancel(organiserId, request, input.event),
    finish: (organiserId, request, input) => status.finish(organiserId, request, input.event),
    scheduleFinish: (organiserId, request, input) =>
      finishSchedules.schedule(organiserId, request, input),
    cancelScheduledFinish: (organiserId, request, input) =>
      finishSchedules.cancel(organiserId, request, input),
    finishSchedule: (organiserId, input) => finishSchedules.get(organiserId, input),
    decreaseCapacity: (organiserId, request, input) =>
      capacity.decrease(organiserId, request, input),
    passWindow: (organiserId, input) => passWindows.get(organiserId, input),
    setPassWindow: (organiserId, request, input) => passWindows.set(organiserId, request, input),
    createEvent: createEventWith({ ...options, saleAssets }),
    setSaleAsset: (organiserId, request, input) => saleAssets.set(organiserId, request, input),
    saleAsset: (organiserId, input) => saleAssets.get(organiserId, input),
    setClassPrice: (organiserId, request, input) => classes.setPrice(organiserId, request, input),
    addZone: (organiserId, request, input) => zones.addZone(organiserId, request, input),
    removeZone: (organiserId, request, input) => zones.removeZone(organiserId, request, input),
    addSeatPositions: (organiserId, request, input) =>
      zones.addSeatPositions(organiserId, request, input),
    seatPositions: (organiserId, input) => zones.seatPositions(organiserId, input),
    issueGranted,
    removeRestriction: removeRestrictionWith(options),
    createInvitation: (organiserId, request, input) =>
      invitations.create(organiserId, request, input),
    listInvitations: (organiserId, input) => invitations.list(organiserId, input),
    redeemInvitation: (holder, request, input) => invitations.redeem(holder, request, input),
    defineClass: (organiserId, request, input) => classes.define(organiserId, request, input),
    listClasses: (organiserId, input) => classes.list(organiserId, input),
  };
}
