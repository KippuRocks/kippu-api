import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  assertMigrated,
  MigrationError,
  migrate,
  readMigrations,
} from "../../src/store/migrate.js";
import { createTestDatabase, describeWithStore, type TestDatabase } from "../support/database.js";

it("ships migrations named NNNN_snake_case.sql, in order", async () => {
  const migrations = await readMigrations();
  expect(migrations.length).toBeGreaterThan(0);
  expect(migrations[0]?.id).toBe("0001_kippu_store");
  const ids = migrations.map((migration) => migration.id);
  expect([...ids].sort()).toEqual(ids);
});

describeWithStore("migrations against PostgreSQL", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await database.drop();
  });

  async function scratchMigrations(files: Record<string, string>) {
    const directory = await mkdtemp(join(tmpdir(), "kippu-migrations-"));
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(join(directory, name), sql);
    }
    return {
      url: pathToFileURL(`${directory}/`),
      write: (name: string, sql: string) => writeFile(join(directory, name), sql),
      remove: () => rm(directory, { recursive: true, force: true }),
    };
  }

  it("applies every migration to an empty store, then nothing on a second run", async () => {
    const shipped = (await readMigrations()).map((migration) => migration.id);

    await expect(assertMigrated(database.store)).rejects.toThrow(MigrationError);
    expect(await migrate(database.store)).toEqual(shipped);
    expect(await migrate(database.store)).toEqual([]);
    await expect(assertMigrated(database.store)).resolves.toBeUndefined();
  });

  it("REQ-IX-1: records the store's role on its schema", async () => {
    await migrate(database.store);
    const result = await database.store.query<{ comment: string }>(
      "SELECT obj_description('public'::regnamespace, 'pg_namespace') AS comment",
    );
    expect(result.rows[0]?.comment).toContain("REQ-IX-1");
  });

  it("serialises concurrent runs", async () => {
    const runs = await Promise.all([migrate(database.store), migrate(database.store)]);
    expect(runs.flat()).toEqual((await readMigrations()).map((migration) => migration.id));
  });

  it("refuses a migration that changed after it was applied", async () => {
    const scratch = await scratchMigrations({ "0001_first.sql": "CREATE TABLE first (id int);" });
    try {
      await migrate(database.store, await readMigrations(scratch.url));
      await scratch.write("0001_first.sql", "CREATE TABLE first (id bigint);");
      await expect(migrate(database.store, await readMigrations(scratch.url))).rejects.toThrow(
        /has changed since it was applied/,
      );
    } finally {
      await scratch.remove();
    }
  });

  it("rolls back a failing migration and applies nothing of it", async () => {
    const scratch = await scratchMigrations({
      "0001_broken.sql": "CREATE TABLE half (id int); SELECT * FROM missing_table;",
    });
    try {
      await expect(migrate(database.store, await readMigrations(scratch.url))).rejects.toThrow(
        MigrationError,
      );
      const table = await database.store.query<{ present: boolean }>(
        "SELECT to_regclass('half') IS NOT NULL AS present",
      );
      expect(table.rows[0]?.present).toBe(false);
      await expect(assertMigrated(database.store, [])).resolves.toBeUndefined();
    } finally {
      await scratch.remove();
    }
  });
});
