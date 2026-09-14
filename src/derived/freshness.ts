import { type Cursor, LOG_START, type Timestamp } from "@ticketto/sdk";
import type pg from "pg";
import type { Store } from "../store/store.js";
import { DERIVED_APPLIED_CHANNEL } from "./reader.js";

/**
 * How far the derived copy has read the ledger's log, stated on every read
 * response (`F-025` plan §5.2, §5.3, `NFR-11`).
 */
export interface CopyFreshness {
  /**
   * The cursor of the last record the copy reflects, or `LOG_START` before the
   * first. A write whose receipt carries this cursor is reflected.
   */
  readonly cursor: Cursor;
  /** How many log records the copy reflects. */
  readonly records: number;
  /** When the ledger recorded the last record the copy reflects, by its clock; `null` before the first. */
  readonly lastRecordedAt: Timestamp | null;
}

export interface Freshness {
  /**
   * Resolves `true` once the copy reflects the record at `cursor` — a
   * submission's receipt cursor — or `false` if `timeout` ms pass first. A
   * client calls it after a write to show the new state without guessing.
   */
  waitFor(cursor: Cursor, timeout: number): Promise<boolean>;
  /** Where the copy is now. */
  current(): Promise<CopyFreshness>;
  /** Stops listening for applied batches. */
  close(): Promise<void>;
}

export interface FreshnessOptions {
  readonly store: Store;
  /**
   * How often a waiter re-checks the copy when no notification arrives, in ms.
   * Notifications are the fast path; this bounds what a missed one costs.
   * Defaults to 500.
   */
  readonly pollInterval?: number;
}

/** The copy's head, read in the same statement as whatever it accompanies. */
export const HEAD_SQL = `
  SELECT r.cursor AS head_cursor, r.next_sequence AS head_records, l.recorded_at AS head_recorded_at
  FROM derived_reader r
  LEFT JOIN derived_log l ON l.sequence = r.next_sequence - 1
  WHERE r.id`;

export interface HeadColumns {
  head_cursor: string;
  head_records: string;
  head_recorded_at: string | null;
}

export function freshnessOf(row: HeadColumns): CopyFreshness {
  return {
    cursor: row.head_cursor as Cursor,
    records: Number(row.head_records),
    lastRecordedAt: row.head_recorded_at === null ? null : Number(row.head_recorded_at),
  };
}

interface Listener {
  readonly client: pg.PoolClient;
  release(error?: Error): void;
}

export function createFreshness(options: FreshnessOptions): Freshness {
  const { store } = options;
  const pollInterval = options.pollInterval ?? 500;
  if (!Number.isSafeInteger(pollInterval) || pollInterval < 1) {
    throw new RangeError(`pollInterval must be a positive integer, not ${pollInterval}`);
  }

  const waiters = new Set<() => void>();
  let listener: Promise<Listener> | null = null;
  let closed = false;

  const wakeAll = () => {
    for (const wake of [...waiters]) wake();
  };

  /** One connection listening for applied batches, shared by every waiter. Re-opened if lost. */
  const listen = (): Promise<Listener> => {
    if (listener === null) {
      const opening = (async () => {
        const client = await store.connect();
        let released = false;
        const release = (error?: Error) => {
          if (released) return;
          released = true;
          client.removeListener("notification", wakeAll);
          client.removeListener("error", lost);
          client.release(error);
        };
        const lost = (error: Error) => {
          if (listener === opening) listener = null;
          release(error);
        };
        client.on("notification", wakeAll);
        client.on("error", lost);
        try {
          await client.query(`LISTEN ${DERIVED_APPLIED_CHANNEL}`);
        } catch (error) {
          release(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
        return { client, release };
      })();
      listener = opening;
      opening.catch(() => {
        if (listener === opening) listener = null;
      });
    }
    return listener;
  };

  const reached = async (cursor: Cursor): Promise<boolean> => {
    const result = await store.query("SELECT 1 FROM derived_log WHERE cursor = $1", [cursor]);
    return (result.rowCount ?? 0) > 0;
  };

  return {
    async waitFor(cursor, timeout) {
      if (closed) throw new Error("freshness is closed");
      if (!Number.isFinite(timeout) || timeout < 0) {
        throw new RangeError(`a timeout is a non-negative number of ms, not ${timeout}`);
      }
      if (cursor === LOG_START) return true;
      const deadline = Date.now() + timeout;
      try {
        await listen();
      } catch {
        // Without notifications, polling still answers; it only answers later.
      }
      for (;;) {
        // Registered before checking, so a batch committed in between still wakes it.
        let wake = () => {};
        const woken = new Promise<void>((resolve) => {
          wake = resolve;
        });
        waiters.add(wake);
        let timer: NodeJS.Timeout | undefined;
        try {
          if (await reached(cursor)) return true;
          if (closed) return false;
          const left = deadline - Date.now();
          if (left <= 0) return false;
          await Promise.race([
            woken,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, Math.min(left, pollInterval));
            }),
          ]);
        } finally {
          clearTimeout(timer);
          waiters.delete(wake);
        }
      }
    },
    async current() {
      const result = await store.query<HeadColumns>(HEAD_SQL);
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("the derived reader's cursor row is missing; is the store migrated?");
      }
      return freshnessOf(row);
    },
    async close() {
      closed = true;
      wakeAll();
      const open = listener;
      listener = null;
      if (open !== null) {
        try {
          const { client, release } = await open;
          try {
            await client.query(`UNLISTEN ${DERIVED_APPLIED_CHANNEL}`);
            release();
          } catch (error) {
            release(error instanceof Error ? error : new Error(String(error)));
          }
        } catch {
          // It never opened.
        }
      }
    },
  };
}
