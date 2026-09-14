import type { Store } from "../../src/store/store.js";

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
