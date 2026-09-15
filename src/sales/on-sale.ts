import type { Event, EventId, EventStatus } from "@ticketto/sdk";
import { SpecCodeError } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";

/** The §10 code for each status an event is not on sale in (`REQ-EV-8`). */
const NOT_ON_SALE: Record<Exclude<EventStatus, "Active">, string> = {
  Sealed: "ERR-EventSealed",
  Cancelled: "ERR-EventCancelled",
  Finished: "ERR-EventFinished",
};

/**
 * The event, as the ledger records it now, provided it is on sale: it exists
 * (`ERR-EventNotFound`) and is `Active` — a sealed, cancelled or finished event
 * issues nothing, so nothing of it is sold or held.
 */
export async function eventOnSale(
  ledger: Pick<KippuTicketto, "getEvent">,
  event: string,
): Promise<Event> {
  const found = await ledger.getEvent(event as EventId);
  if (!found.ok) {
    throw new SpecCodeError(found.error.code, found.error.detail);
  }
  const { status } = found.value;
  if (status !== "Active") {
    throw new SpecCodeError(NOT_ON_SALE[status], `the event is ${status}`);
  }
  return found.value;
}
