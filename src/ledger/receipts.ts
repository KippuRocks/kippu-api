import type { Cursor, Receipt, Result } from "@ticketto/sdk";
import type { KippuTicketto } from "./ticketto.js";

/**
 * The receipt cursor of the latest write this process settled. The sponsor
 * relay's client sends it as `after`, so a relay whose copy of ledger facts
 * lags behind that write waits for it instead of refusing the next one — an
 * event's first ticket issued right after the event is created, say
 * (`REQ-SP-5`; `F-023` plan §5.3).
 */
export interface ReceiptTracker {
  latest(): Cursor | undefined;
}

type Settling = PromiseLike<Result<Receipt>>;

const WRITES = [
  "createEvent",
  "setEventStatus",
  "setEventCapacity",
  "addZone",
  "removeZone",
  "issueTicket",
  "transferTicket",
  "removeRestriction",
  "registerCredential",
  "submitAccessPass",
] as const satisfies readonly (keyof KippuTicketto)[];

/**
 * `ledger`, with every settled write's receipt cursor recorded in the returned
 * tracker. Submissions are observed, never consumed: callers see them unchanged.
 */
export function trackReceipts(ledger: KippuTicketto): {
  readonly ledger: KippuTicketto;
  readonly receipts: ReceiptTracker;
} {
  let latest: Cursor | undefined;
  const observe = (settling: Settling) => {
    settling.then(
      (result) => {
        if (result.ok) latest = result.value.cursor;
      },
      () => {},
    );
  };
  const tracked: Record<string, unknown> = { ...ledger };
  for (const name of WRITES) {
    const write = ledger[name] as (...args: unknown[]) => Settling | { submission: Settling };
    tracked[name] = (...args: unknown[]) => {
      const out = write.apply(ledger, args);
      observe("submission" in out ? out.submission : out);
      return out;
    };
  }
  Object.defineProperty(tracked, "log", { get: () => ledger.log, enumerable: true });
  return { ledger: tracked as unknown as KippuTicketto, receipts: { latest: () => latest } };
}
