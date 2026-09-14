import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type pg from "pg";

/** Where the migrations live, relative to both `src/store` and `dist/store`. */
export const MIGRATIONS_DIRECTORY = new URL("../../migrations/", import.meta.url);

/** `NNNN_snake_case.sql`. Applied in order of their number. */
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Taken for the whole run, so two processes never migrate at once. */
const MIGRATION_LOCK = 0x6b697070; // "kipp"

export interface Migration {
  readonly id: string;
  readonly sql: string;
  readonly checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export async function readMigrations(
  directory: URL = MIGRATIONS_DIRECTORY,
): Promise<readonly Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  const numbers = new Set<string>();
  for (const name of names) {
    const match = MIGRATION_FILE.exec(name);
    if (match === null) {
      throw new MigrationError(`migration file name "${name}" is not NNNN_snake_case.sql`);
    }
    const number = match[1] as string;
    if (numbers.has(number)) {
      throw new MigrationError(`two migrations are numbered ${number}`);
    }
    numbers.add(number);
    const sql = await readFile(new URL(name, directory), "utf8");
    migrations.push({
      id: name.slice(0, -".sql".length),
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return migrations;
}

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS kippu_migrations (
    id text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

interface AppliedRow {
  readonly id: string;
  readonly checksum: string;
}

async function applied(client: pg.PoolClient | pg.Pool): Promise<Map<string, string>> {
  const exists = await client.query<{ present: boolean }>(
    "SELECT to_regclass('kippu_migrations') IS NOT NULL AS present",
  );
  if (exists.rows[0]?.present !== true) {
    return new Map();
  }
  const result = await client.query<AppliedRow>("SELECT id, checksum FROM kippu_migrations");
  return new Map(result.rows.map((row) => [row.id, row.checksum]));
}

/**
 * Compares what the store has applied with what this build ships. An applied
 * migration that has changed since, or that this build does not know, is an
 * error: migrations are append-only.
 */
function pending(
  migrations: readonly Migration[],
  done: ReadonlyMap<string, string>,
): readonly Migration[] {
  const known = new Set(migrations.map((migration) => migration.id));
  for (const id of done.keys()) {
    if (!known.has(id)) {
      throw new MigrationError(`the store has applied ${id}, which this build does not ship`);
    }
  }
  for (const migration of migrations) {
    const checksum = done.get(migration.id);
    if (checksum !== undefined && checksum !== migration.checksum) {
      throw new MigrationError(`${migration.id} has changed since it was applied`);
    }
  }
  return migrations.filter((migration) => !done.has(migration.id));
}

/**
 * Applies every pending migration, each in its own transaction, and returns
 * the ids applied. Safe to run repeatedly and concurrently.
 */
export async function migrate(
  pool: pg.Pool,
  migrations?: readonly Migration[],
): Promise<readonly string[]> {
  const all = migrations ?? (await readMigrations());
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    try {
      await client.query(CREATE_MIGRATIONS_TABLE);
      const todo = pending(all, await applied(client));
      for (const migration of todo) {
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query("INSERT INTO kippu_migrations (id, checksum) VALUES ($1, $2)", [
            migration.id,
            migration.checksum,
          ]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw new MigrationError(`${migration.id} failed: ${(error as Error).message}`);
        }
      }
      return todo.map((migration) => migration.id);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    }
  } finally {
    client.release();
  }
}

/** Refuses a store that is behind, ahead of, or diverged from this build. */
export async function assertMigrated(
  pool: pg.Pool,
  migrations?: readonly Migration[],
): Promise<void> {
  const all = migrations ?? (await readMigrations());
  const todo = pending(all, await applied(pool));
  if (todo.length > 0) {
    throw new MigrationError(
      `the store has pending migrations (${todo.map((m) => m.id).join(", ")}); run \`pnpm migrate\``,
    );
  }
}
