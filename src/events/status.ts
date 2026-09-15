import type { EventId, EventStatus } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { SpecCodeError } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { OrganiserSaleActions } from "../sales/organiser-actions.js";
import { ownedEvent } from "./ownership.js";
import type { EventsRequest, StatusChanged } from "./ports.js";

/** How often recording a cancelled event's refund entitlements is tried before giving up. */
export const REFUND_RECORDING_ATTEMPTS = 3;

export interface StatusOptions {
  readonly authority: Pick<OrganiserAuthority, "account" | "relay">;
  readonly ledger: Pick<KippuTicketto, "getEvent" | "setEventStatus">;
  /** `F-022`'s organiser sale actions (`T-022-05`, `T-022-07`), resolved when called. */
  readonly saleActions: () => Pick<
    OrganiserSaleActions,
    "releaseAll" | "reopenSales" | "recordCancellationRefunds"
  >;
  /** Receives failures no caller awaits, such as refund recording that kept failing. */
  readonly onError?: (error: unknown) => void;
}

export interface StatusTransitions {
  /** `Active → Sealed` (`US-A4`). */
  seal(organiserId: string, request: EventsRequest, event: string): Promise<StatusChanged>;
  /** `Active | Sealed → Cancelled` (`US-A5`). */
  cancel(organiserId: string, request: EventsRequest, event: string): Promise<StatusChanged>;
  /** `Active | Sealed → Finished` (`REQ-EV-12`). */
  finish(organiserId: string, request: EventsRequest, event: string): Promise<StatusChanged>;
}

/**
 * Seal, cancel and finish (`T-021-09`; `US-A4`, `US-A5`, `REQ-EV-11`, `REQ-EV-12`,
 * `REQ-HD-4`; `F-021` plan §5.5, `F-022` plan §5.3). Every transition is signed
 * with the organiser's authority, and the ledger decides whether it is permitted
 * (`ERR-InvalidTransition`, `REQ-EV-11`).
 *
 * Only an `Active` event is still selling, so only an `Active` event has its sales
 * released first: a `Sealed` event's sales closed when it was sealed, and a
 * `Cancelled` or `Finished` one's before that. Sales reopen on a ledger refusal
 * only when this call closed them.
 *
 * - **Seal**: `F-022`'s `releaseAll` first — sales close, holds are released,
 *   open hosted checkouts are cancelled and payments already taken become refund
 *   entitlements — then `Sealed` is submitted.
 * - **Cancel**: `releaseAll` for an `Active` event, then `Cancelled`. Once
 *   the ledger records the cancellation, one refund entitlement per purchased
 *   ticket is recorded (`AC-A5.5`, `T-022-07`), retried if it fails. Cancelling
 *   an event the ledger already has `Cancelled` records the entitlements again —
 *   which is idempotent — so a cancellation whose refunds failed can be retried.
 * - **Finish**: a `Finished` event issues nothing (`INV-16`), so an `Active` one
 *   has its sales released first, as for a seal.
 */
export function createStatusTransitions(options: StatusOptions): StatusTransitions {
  const { authority, ledger, saleActions, onError = (error) => console.error(error) } = options;

  const cause = (request: EventsRequest) => ({
    requestId: request.requestId,
    actor: request.principal,
  });

  const submit = async (
    organiserId: string,
    request: EventsRequest,
    event: string,
    status: Exclude<EventStatus, "Active">,
    release: boolean,
  ): Promise<StatusChanged> => {
    if (release) await saleActions().releaseAll(event, cause(request));
    // A submission with no verdict throws: the status may have changed, so sales stay closed.
    const result = await authority.relay(organiserId, request, (signer) =>
      ledger.setEventStatus(signer, { event: event as EventId, status }),
    );
    if (!result.ok) {
      if (release) await saleActions().reopenSales(event, cause(request));
      throw new SpecCodeError(result.error.code, result.error.detail);
    }
    return { event, status, cursor: result.value.cursor };
  };

  const recordRefunds = async (request: EventsRequest, event: string): Promise<void> => {
    let failure: unknown;
    for (let attempt = 0; attempt < REFUND_RECORDING_ATTEMPTS; attempt += 1) {
      try {
        await saleActions().recordCancellationRefunds(event, cause(request));
        return;
      } catch (error) {
        failure = error;
      }
    }
    // The event is cancelled either way; cancelling it again retries the recording.
    onError(failure);
    throw failure;
  };

  return {
    async seal(organiserId, request, event) {
      const { event: current } = await ownedEvent(ledger, authority, organiserId, event as EventId);
      return submit(organiserId, request, event, "Sealed", current.status === "Active");
    },

    async cancel(organiserId, request, event) {
      const { event: current } = await ownedEvent(ledger, authority, organiserId, event as EventId);
      if (current.status === "Cancelled") {
        // Already cancelled: only the refund entitlements, which are recorded at most once.
        await recordRefunds(request, event);
        return { event, status: "Cancelled", cursor: null };
      }
      const changed = await submit(
        organiserId,
        request,
        event,
        "Cancelled",
        current.status === "Active",
      );
      await recordRefunds(request, event);
      return changed;
    },

    async finish(organiserId, request, event) {
      const { event: current } = await ownedEvent(ledger, authority, organiserId, event as EventId);
      return submit(organiserId, request, event, "Finished", current.status === "Active");
    },
  };
}
