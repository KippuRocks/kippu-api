import type { EventId, TicketId } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { SpecCodeError } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import { ownedEvent } from "./ownership.js";
import type { EventsRequest, RemoveRestrictionInput, RestrictionRemoved } from "./ports.js";

export interface RestrictionsOptions {
  readonly authority: Pick<OrganiserAuthority, "account" | "relay">;
  readonly ledger: Pick<KippuTicketto, "getEvent" | "getTicket" | "removeRestriction">;
}

/**
 * Restriction removal (`T-021-10`; `REQ-TK-6`, `AC-B3.4`). An organiser may free
 * a granted ticket of their event for resale or transfer; nobody may add a
 * restriction after issuance (`INV-10`), and Kippu has no way to. The ledger's
 * `removeRestriction`, signed with the organiser's authority, only ever clears a
 * flag: clearing `cannotResale` on a ticket that also cannot be transferred
 * clears both (`REQ-TK-2`). Its verdict — `ERR-TicketNotFound`, say — is passed on.
 */
export function removeRestrictionWith(options: RestrictionsOptions) {
  const { authority, ledger } = options;
  return async (
    organiserId: string,
    request: EventsRequest,
    input: RemoveRestrictionInput,
  ): Promise<RestrictionRemoved> => {
    await ownedEvent(ledger, authority, organiserId, input.event as EventId);
    const result = await authority.relay(organiserId, request, (signer) =>
      ledger.removeRestriction(signer, {
        event: input.event as EventId,
        ticket: input.ticket as TicketId,
        restriction: input.restriction,
      }),
    );
    if (!result.ok) {
      throw new SpecCodeError(result.error.code, result.error.detail);
    }
    const ticket = await ledger.getTicket(input.ticket as TicketId);
    if (!ticket.ok) {
      throw new SpecCodeError(ticket.error.code, ticket.error.detail);
    }
    return {
      event: input.event,
      ticket: input.ticket,
      restrictions: ticket.value.restrictions,
      cursor: result.value.cursor,
    };
  };
}
