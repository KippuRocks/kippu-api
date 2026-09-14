import { type Cursor, LOG_START, type LogReader, type LogRecord } from "@ticketto/sdk";
import type { Store } from "../../src/store/store.js";

/** Every record in a ledger's log, read from the start through the SDK. */
export async function wholeLog(log: LogReader): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  let cursor = LOG_START;
  for (;;) {
    const page = await log.read(cursor, 50);
    if (!page.ok) throw new Error(page.error.code);
    if (page.value.records.length === 0) return records;
    records.push(...page.value.records);
    cursor = page.value.next;
  }
}

/**
 * A log serving the given records, with cursors `"0"`, `"1"`, … in order, as
 * `backend-memory` issues them. For records the ledger's rules cannot yet
 * produce; its hints never arrive.
 */
export function scriptedLog(records: readonly Omit<LogRecord, "cursor">[]): {
  readonly log: LogReader;
  readonly records: readonly LogRecord[];
} {
  const served = records.map((record, index) => ({ ...record, cursor: String(index) as Cursor }));
  return {
    records: served,
    log: {
      async read(from, limit) {
        const start = from === LOG_START ? 0 : served.findIndex((r) => r.cursor === from) + 1;
        if (start === 0 && from !== LOG_START) throw new RangeError(`unknown cursor ${from}`);
        const page = served.slice(start, start + limit);
        return { ok: true, value: { records: page, next: page.at(-1)?.cursor ?? from } };
      },
      hints: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<Cursor>>(() => {}),
          return: async () => ({ done: true, value: undefined }),
        }),
      }),
    },
  };
}

/** Columns that record when a row was written, not what it says. */
const WALL_CLOCK_COLUMNS = new Set(["updated_at"]);

/**
 * Every row of every `derived_*` table, in a fixed order, without wall-clock
 * columns: two copies built from the same log compare equal.
 */
export async function derivedSnapshot(store: Store): Promise<Record<string, unknown[]>> {
  const tables = await store.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'derived\\_%'
     ORDER BY table_name`,
  );
  const snapshot: Record<string, unknown[]> = {};
  for (const { table_name: table } of tables.rows) {
    const columns = await store.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    );
    const kept = columns.rows
      .map(({ column_name }) => column_name)
      .filter((column) => !WALL_CLOCK_COLUMNS.has(column))
      .map((column) => `"${column}"`);
    const rows = await store.query(
      `SELECT ${kept.join(", ")} FROM "${table}" ORDER BY ${kept.map((_, i) => i + 1).join(", ")}`,
    );
    snapshot[table] = rows.rows;
  }
  return snapshot;
}
