import type { AccountId, Event, EventId } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { SpecCodeError } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";

/**
 * The event, as the ledger records it now, provided the organiser owns it:
 * `ERR-EventNotFound` when the ledger has no such event, `ERR-NotOwner` when its
 * owner is not the organiser's ledger account. Ownership is a ledger fact
 * (`REQ-IX-1`), so it is read from the ledger, not from Kippu's store.
 */
export async function ownedEvent(
  ledger: Pick<KippuTicketto, "getEvent">,
  authority: Pick<OrganiserAuthority, "account">,
  organiserId: string,
  event: EventId,
): Promise<{ readonly event: Event; readonly account: AccountId }> {
  const found = await ledger.getEvent(event);
  if (!found.ok) {
    throw new SpecCodeError(found.error.code, found.error.detail);
  }
  const account = await authority.account(organiserId);
  if (account === null || found.value.owner !== account) {
    throw new SpecCodeError("ERR-NotOwner", "the organiser does not own the event");
  }
  return { event: found.value, account };
}
