import { DEFAULT_PASS_WINDOW } from "@ticketto/profile-v0";
import type { EventId } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { RefusedRequest } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import { ownedEvent } from "./ownership.js";
import type { EventInput, EventPassWindow, EventsRequest, SetPassWindowInput } from "./ports.js";

/** The shortest pass window an organiser may set: 10 seconds (`F-021` plan, "Pass window"). */
export const MIN_PASS_WINDOW_MS = 10_000;

export interface PassWindows {
  get(organiserId: string, input: EventInput): Promise<EventPassWindow>;
  set(
    organiserId: string,
    request: EventsRequest,
    input: SetPassWindowInput,
  ): Promise<EventPassWindow>;
}

export interface PassWindowsOptions {
  readonly store: Store;
  readonly authority: Pick<OrganiserAuthority, "account">;
  readonly ledger: Pick<KippuTicketto, "getEvent">;
  /**
   * The ledger's maximum pass window, in milliseconds: the rules configuration
   * the server runs the ledger with (`ledgerLimits`), never a constant of its own.
   */
  readonly maxPassWindow: number;
  readonly now?: () => Date;
}

/**
 * Each event's pass window (`T-021-15`; `NFR-5`, `REQ-AP-3`): how long an access
 * pass for the event stays valid, set by its organiser between
 * {@link MIN_PASS_WINDOW_MS} and the ledger's maximum, 60 seconds by default
 * (the profile's `DEFAULT_PASS_WINDOW`). The ledger enforces only its maximum,
 * so the window is a Kippu setting: Saifu produces passes with it and Iriguchi
 * shows it (their reads are `T-025-11`).
 */
export function createPassWindows(options: PassWindowsOptions): PassWindows {
  const { store, authority, ledger, maxPassWindow, now = () => new Date() } = options;
  if (!Number.isSafeInteger(maxPassWindow) || maxPassWindow < MIN_PASS_WINDOW_MS) {
    throw new RangeError(
      `the ledger's maximum pass window must be at least ${MIN_PASS_WINDOW_MS} ms`,
    );
  }
  const defaultWindow = Math.min(DEFAULT_PASS_WINDOW, maxPassWindow);

  const read = async (event: string): Promise<EventPassWindow> => {
    const row = (
      await store.query<{ window_ms: number }>(
        "SELECT window_ms FROM event_pass_windows WHERE event = $1",
        [event],
      )
    ).rows[0];
    return {
      event,
      windowMs: row?.window_ms ?? defaultWindow,
      isDefault: row === undefined,
      minimumMs: MIN_PASS_WINDOW_MS,
      maximumMs: maxPassWindow,
    };
  };

  return {
    async get(organiserId, input) {
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      return read(input.event);
    },

    async set(organiserId, request, input) {
      if (
        !Number.isSafeInteger(input.windowMs) ||
        input.windowMs < MIN_PASS_WINDOW_MS ||
        input.windowMs > maxPassWindow
      ) {
        throw new RefusedRequest(
          `a pass window is between ${MIN_PASS_WINDOW_MS} and ${maxPassWindow} milliseconds`,
        );
      }
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      await store.query(
        `INSERT INTO event_pass_windows (event, window_ms, organiser_id, set_request_id, set_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (event) DO UPDATE
           SET window_ms = EXCLUDED.window_ms, organiser_id = EXCLUDED.organiser_id,
               set_request_id = EXCLUDED.set_request_id, set_at = EXCLUDED.set_at`,
        [input.event, input.windowMs, organiserId, request.requestId, now()],
      );
      return read(input.event);
    },
  };
}
