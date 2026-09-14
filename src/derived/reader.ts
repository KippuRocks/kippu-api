import type { Cursor, LogReader, LogRecord, TickettoErrorCode } from "@ticketto/sdk";
import type { Store } from "../store/store.js";
import { type DerivedTransaction, entryKind, type Projection } from "./projection.js";

/**
 * The derived copy's reader (`F-025` plan §5.1, `NFR-11`, `AD-17`).
 *
 * It pulls the ledger's log through the SDK (`REQ-SDK-9`) from a durable
 * cursor, in batches. Each batch — every projection's updates, the record of
 * what was applied, and the new cursor — is one transaction in the Kippu store,
 * so a crash can neither skip a record nor apply one twice. Hints only shorten
 * the wait between pulls: a lost hint costs latency, never data, and a poll
 * interval bounds the latency it costs.
 */
export interface DerivedReader {
  /** Pulls and applies at most one batch. */
  step(): Promise<AppliedBatch>;
  /** Steps until a pull returns nothing, and returns how many records were applied. */
  catchUp(): Promise<number>;
  /** Runs the reader in the background until {@link stop}. Errors go to `onError`, and it retries. */
  start(): void;
  /** Stops the background reader, after any batch in flight commits or rolls back. */
  stop(): Promise<void>;
  /** Where the reader has read to, as committed. */
  position(): Promise<ReaderPosition>;
}

export interface ReaderPosition {
  /** The cursor the next pull reads from. */
  readonly cursor: Cursor;
  /** The log sequence the next record takes: how many records have been applied. */
  readonly nextSequence: number;
}

/** What one step committed. */
export interface AppliedBatch extends ReaderPosition {
  /** The records applied, in log order; none when the reader was already at the log's head. */
  readonly records: readonly LogRecord[];
}

export interface DerivedReaderOptions {
  readonly store: Store;
  /** The ledger's log, read through the SDK (`REQ-SDK-9`). */
  readonly log: LogReader;
  /** The projections every record is applied to, in order. */
  readonly projections: readonly Projection[];
  /** Records pulled per batch. Defaults to 100. */
  readonly batchSize?: number;
  /** The longest the background reader waits for a hint before pulling anyway, in ms. Defaults to 1000. */
  readonly pollInterval?: number;
  /** How long the background reader waits after a failed step, in ms. Defaults to 1000. */
  readonly retryDelay?: number;
  /** Receives every failure of the background reader. Defaults to `console.error`. */
  readonly onError?: (error: unknown) => void;
}

/** The ledger could not answer a read of its log. Retryable. */
export class LedgerReadError extends Error {
  readonly code: TickettoErrorCode;

  constructor(code: TickettoErrorCode, detail?: string) {
    super(
      `reading the ledger's log failed with ${code}${detail === undefined ? "" : `: ${detail}`}`,
    );
    this.name = "LedgerReadError";
    this.code = code;
  }
}

/** The log answered with a page that breaks the `LogReader` contract. Not retryable by waiting. */
export class LogContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogContractError";
  }
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL = 1000;
const DEFAULT_RETRY_DELAY = 1000;

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, not ${value}`);
  }
  return value;
}

/** Records one applied record, so the copy can say which cursors it has reached. */
async function recordApplied(
  tx: DerivedTransaction,
  sequence: number,
  record: LogRecord,
): Promise<void> {
  const kind = entryKind(record);
  await tx.query(
    `INSERT INTO derived_log
       (sequence, cursor, recorded_at, event_id, event_sequence, entry_kind, operation_id, presented_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      sequence,
      record.cursor,
      record.recordedAt,
      record.event?.id ?? null,
      record.event?.sequence ?? null,
      kind,
      "command" in record.entry ? record.entry.command.operationId : null,
      record.presentedAt,
    ],
  );
}

async function readPosition(
  client: DerivedTransaction | Store,
  lock: boolean,
): Promise<ReaderPosition> {
  const result = await client.query<{ cursor: string; next_sequence: string }>(
    `SELECT cursor, next_sequence FROM derived_reader WHERE id${lock ? " FOR UPDATE" : ""}`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("the derived reader's cursor row is missing; is the store migrated?");
  }
  return { cursor: row.cursor as Cursor, nextSequence: Number(row.next_sequence) };
}

export function createDerivedReader(options: DerivedReaderOptions): DerivedReader {
  const { store, log, projections } = options;
  const batchSize = positiveInteger("batchSize", options.batchSize ?? DEFAULT_BATCH_SIZE);
  const pollInterval = positiveInteger(
    "pollInterval",
    options.pollInterval ?? DEFAULT_POLL_INTERVAL,
  );
  const retryDelay = positiveInteger("retryDelay", options.retryDelay ?? DEFAULT_RETRY_DELAY);
  const onError = options.onError ?? ((error: unknown) => console.error(error));

  const step = async (): Promise<AppliedBatch> => {
    const tx = await store.connect();
    // A connection lost mid-batch — the process on the other end killed, say —
    // fails the query in flight; the event must not also crash the process.
    const lost = (): void => {};
    tx.on("error", lost);
    let released = false;
    const release = (error?: Error) => {
      if (!released) {
        released = true;
        tx.removeListener("error", lost);
        tx.release(error);
      }
    };
    try {
      await tx.query("BEGIN");
      const from = await readPosition(tx, true);
      const page = await log.read(from.cursor, batchSize);
      if (!page.ok) {
        throw new LedgerReadError(page.error.code, page.error.detail);
      }
      const { records, next } = page.value;
      if (records.length > batchSize) {
        throw new LogContractError(`asked for ${batchSize} records, got ${records.length}`);
      }
      const last = records.at(-1);
      if (
        (last === undefined && next !== from.cursor) ||
        (last !== undefined && next !== last.cursor)
      ) {
        throw new LogContractError("a page's next cursor is not its last record's cursor");
      }
      if (records.length === 0) {
        await tx.query("ROLLBACK");
        return { ...from, records };
      }

      let sequence = from.nextSequence;
      for (const record of records) {
        await recordApplied(tx, sequence, record);
        for (const projection of projections) {
          await projection.apply(tx, { sequence, record });
        }
        sequence += 1;
      }
      await tx.query(
        "UPDATE derived_reader SET cursor = $1, next_sequence = $2, updated_at = now() WHERE id",
        [next, sequence],
      );
      await tx.query("COMMIT");
      return { cursor: next, nextSequence: sequence, records };
    } catch (error) {
      try {
        await tx.query("ROLLBACK");
      } catch {
        // The connection is gone, and the transaction with it: discard the client.
        release(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    } finally {
      release();
    }
  };

  let stopping = false;
  let running: Promise<void> | null = null;
  let wake: (() => void) | null = null;

  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });

  const run = async (): Promise<void> => {
    let hints: AsyncIterator<Cursor> | null = null;
    let pending: Promise<IteratorResult<Cursor> | Error> | null = null;
    try {
      while (!stopping) {
        let batch: AppliedBatch;
        try {
          batch = await step();
        } catch (error) {
          onError(error);
          await pause(retryDelay);
          continue;
        }
        if (batch.records.length > 0) {
          continue;
        }

        // At the head: wait for a hint of a cursor other than ours, or the poll interval.
        const deadline = pause(pollInterval);
        let waiting = true;
        while (waiting && !stopping) {
          if (hints === null) {
            try {
              hints = log.hints()[Symbol.asyncIterator]();
            } catch (error) {
              onError(error);
            }
          }
          if (hints !== null && pending === null) {
            pending = hints
              .next()
              .catch((error: unknown) =>
                error instanceof Error ? error : new Error(String(error)),
              );
          }
          const outcome = await Promise.race([
            deadline.then(() => "deadline" as const),
            ...(pending === null ? [] : [pending]),
          ]);
          if (outcome === "deadline") {
            waiting = false;
          } else if (outcome instanceof Error) {
            onError(outcome);
            pending = null;
            hints = null;
            waiting = false;
          } else {
            pending = null;
            if (outcome.done === true) {
              hints = null;
              waiting = false;
            } else if (outcome.value !== batch.cursor) {
              waiting = false;
            }
          }
        }
        wake?.();
      }
    } finally {
      await hints?.return?.();
    }
  };

  return {
    step,
    async catchUp() {
      let applied = 0;
      for (;;) {
        const batch = await step();
        if (batch.records.length === 0) return applied;
        applied += batch.records.length;
      }
    },
    start() {
      if (running !== null) return;
      stopping = false;
      running = run();
    },
    async stop() {
      if (running === null) return;
      stopping = true;
      wake?.();
      await running;
      running = null;
    },
    position: () => readPosition(store, false),
  };
}
