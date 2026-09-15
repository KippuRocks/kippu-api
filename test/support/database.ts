import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe } from "vitest";
import { migrate } from "../../src/store/migrate.js";
import { createStore, type Store } from "../../src/store/store.js";

/**
 * A PostgreSQL server the tests may create databases on: locally the Kippu
 * store from `compose.yaml`, in CI the service container.
 */
const serverUrl = process.env.KIPPU_TEST_DATABASE_URL;

if ((serverUrl === undefined || serverUrl === "") && process.env.CI === "true") {
  throw new Error("KIPPU_TEST_DATABASE_URL must be set in CI: store tests may not be skipped");
}

/** `describe`, skipped when no test database server is configured locally. */
export const describeWithStore = describe.runIf(serverUrl !== undefined && serverUrl !== "");

export interface TestDatabase {
  readonly url: string;
  /** A fresh, empty database; not yet migrated. */
  readonly store: Store;
  drop(): Promise<void>;
}

function withDatabase(url: string, database: string): string {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
}

/** Creates a database of its own for one test file, so files run in parallel. */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (serverUrl === undefined || serverUrl === "") {
    throw new Error("KIPPU_TEST_DATABASE_URL is not set");
  }
  const name = `kippu_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(serverUrl, name);
  const store = createStore(url);
  // `store.end()` resolves once its clients are asked to close, not once their sockets have:
  // dropping the database with FORCE may terminate one still closing. Such a client has
  // already left the pool, so its error would be uncaught; `drop` expects it.
  const clients = new Set<pg.PoolClient>();
  store.on("connect", (client) => clients.add(client));
  return {
    url,
    store,
    async drop() {
      for (const client of clients) client.on("error", () => {});
      await store.end();
      const client = new pg.Client({ connectionString: serverUrl });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}

/** A fresh database with every migration applied. */
export async function createMigratedTestDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase();
  await migrate(database.store);
  return database;
}
