import { type Cursor, LOG_START, type LogReader, type Result } from "@ticketto/sdk";
import pg from "pg";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ledgerFactsProjection } from "../../src/derived/ledger-facts.js";
import type { Projection } from "../../src/derived/projection.js";
import {
  createDerivedReader,
  type DerivedReaderOptions,
  LedgerReadError,
} from "../../src/derived/reader.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { derivedSnapshot, wholeLog } from "../support/derived.js";
import { type MemoryLedger, memoryLedger, zoneId } from "../support/memory-ledger.js";

/** An organiser, a holder, an event and `tickets` tickets: 3 + `tickets` records. */
async function history(ledger: MemoryLedger, tickets: number): Promise<void> {
  await ledger.registerOrganiser();
  const holder = await ledger.registerHolder(0x21);
  const zone = zoneId(0x7a);
  const event = await ledger.createEvent(0x01, [zone]);
  for (let n = 0; n < tickets; n += 1) {
    await ledger.issue(event, zone, n + 1, holder.account);
  }
}

/** A log whose hints never arrive. */
function withoutHints(log: LogReader): LogReader {
  return {
    read: (from, limit) => log.read(from, limit),
    hints: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Cursor>>(() => {}),
        return: async () => ({ done: true, value: undefined }),
      }),
    }),
  };
}

// These tests create databases and write to a ledger: on a loaded machine that
// takes far longer than Vitest's 5 s default, and a test that times out keeps
// running into the next one.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Each test gets a ledger of its own as a fixture, never a variable shared across
 * tests: work a timed-out test leaves running can then never write into the
 * ledger of the test after it.
 */
const test = it.extend<{ ledger: MemoryLedger }>({
  // biome-ignore lint/correctness/noEmptyPattern: Vitest reads a fixture's dependencies from this pattern.
  ledger: async ({}, use) => {
    await use(memoryLedger());
  },
});

describeWithStore("the derived copy's cursor reader", () => {
  let databases: TestDatabase[];
  let stops: (() => Promise<void>)[];

  async function database(): Promise<TestDatabase> {
    const created = await createMigratedTestDatabase();
    databases.push(created);
    return created;
  }

  function reader(
    ledger: MemoryLedger,
    options: Partial<DerivedReaderOptions> & Pick<DerivedReaderOptions, "store">,
  ) {
    const created = createDerivedReader({
      log: ledger.backend.log,
      projections: [],
      retryDelay: 10,
      onError: () => {},
      ...options,
    });
    stops.push(() => created.stop());
    return created;
  }

  beforeEach(() => {
    databases = [];
    stops = [];
  });

  afterEach(async () => {
    for (const stop of stops) await stop();
    for (const created of databases) await created.drop();
  });

  test("applies every record from cursor zero, in log order, with its sequence", async ({
    ledger,
  }) => {
    await history(ledger, 7);
    const { store } = await database();
    const records = await wholeLog(ledger.backend.log);

    expect(await reader(ledger, { store, batchSize: 3 }).catchUp()).toBe(records.length);

    const applied = await store.query<{ sequence: string; cursor: string; entry_kind: string }>(
      "SELECT sequence, cursor, entry_kind FROM derived_log ORDER BY sequence",
    );
    expect(applied.rows).toEqual(
      records.map((record, sequence) => ({
        sequence: String(sequence),
        cursor: record.cursor,
        entry_kind: "command" in record.entry ? record.entry.command.kind : "accessPass",
      })),
    );
    expect(await reader(ledger, { store }).position()).toEqual({
      cursor: records.at(-1)?.cursor,
      nextSequence: records.length,
    });
  });

  test("resumes from its durable cursor, applying only what is new", async ({ ledger }) => {
    await history(ledger, 2);
    const { store } = await database();
    expect(await reader(ledger, { store }).catchUp()).toBe(5);

    const zone = zoneId(0x7a);
    const event = await ledger.createEvent(0x02, [zone]);
    await ledger.issue(event, zone, 9, ledger.organiser.signer.account);

    // A new reader instance: nothing but the store carries the cursor across.
    expect(await reader(ledger, { store }).catchUp()).toBe(2);
    expect((await reader(ledger, { store }).position()).nextSequence).toBe(7);
  });

  test("NFR-11: killing the reader mid-batch, then restarting, yields identical projections", async ({
    ledger,
  }) => {
    await history(ledger, 20);
    const records = await wholeLog(ledger.backend.log);

    const reference = await database();
    const facts = ledgerFactsProjection(ledger.kippu);
    await reader(ledger, { store: reference.store, batchSize: 4, projections: [facts] }).catchUp();

    const crashed = await database();
    const admin = new pg.Client({ connectionString: crashed.url });
    await admin.connect();
    try {
      // Mid-way through the third batch, the reader's connection is killed, as it
      // is when the process holding it dies: PostgreSQL aborts the open transaction.
      const killer: Projection = {
        name: "killer",
        async apply(tx, { sequence }) {
          if (sequence === 9) {
            const { rows } = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            await admin.query("SELECT pg_terminate_backend($1)", [rows[0]?.pid]);
          }
        },
      };
      const doomed = reader(ledger, {
        store: crashed.store,
        batchSize: 4,
        projections: [facts, killer],
      });
      await doomed.step();
      await doomed.step();
      await expect(doomed.step()).rejects.toThrow();

      // The two committed batches are there, and nothing of the third.
      expect(await reader(ledger, { store: crashed.store }).position()).toEqual({
        cursor: records[7]?.cursor,
        nextSequence: 8,
      });
      const partial = await crashed.store.query("SELECT count(*)::int AS n FROM derived_log");
      expect(partial.rows[0]).toEqual({ n: 8 });
      // Records 3 to 7 issued five tickets; the third batch's never landed.
      const tickets = await crashed.store.query("SELECT count(*)::int AS n FROM derived_tickets");
      expect(tickets.rows[0]).toEqual({ n: 5 });

      await reader(ledger, { store: crashed.store, batchSize: 4, projections: [facts] }).catchUp();
      expect(await derivedSnapshot(crashed.store)).toEqual(await derivedSnapshot(reference.store));
    } finally {
      await admin.end();
    }
  });

  test("NFR-11: a projection failing mid-batch rolls back the batch and its cursor", async ({
    ledger,
  }) => {
    await history(ledger, 5);
    const reference = await database();
    await reader(ledger, { store: reference.store, batchSize: 3 }).catchUp();

    const failed = await database();
    let failures = 1;
    const flaky: Projection = {
      name: "flaky",
      async apply(_, { sequence }) {
        if (sequence === 4 && failures > 0) {
          failures -= 1;
          throw new Error("the process died here");
        }
      },
    };
    const first = reader(ledger, { store: failed.store, batchSize: 3, projections: [flaky] });
    await first.step();
    await expect(first.step()).rejects.toThrow("the process died here");
    expect((await first.position()).nextSequence).toBe(3);

    await first.catchUp();
    expect(await derivedSnapshot(failed.store)).toEqual(await derivedSnapshot(reference.store));
  });

  test("two readers on one store never apply a record twice", async ({ ledger }) => {
    await history(ledger, 12);
    const { store } = await database();
    const [a, b] = await Promise.all([
      reader(ledger, { store, batchSize: 2 }).catchUp(),
      reader(ledger, { store, batchSize: 2 }).catchUp(),
    ]);
    expect(a + b).toBe(15);
    const applied = await store.query("SELECT count(*)::int AS n FROM derived_log");
    expect(applied.rows[0]).toEqual({ n: 15 });
  });

  test("leaves the cursor where it was when the ledger cannot answer", async ({ ledger }) => {
    await history(ledger, 1);
    const { store } = await database();
    const unavailable: LogReader = {
      read: async (): Promise<Result<never>> => ({
        ok: false,
        error: { code: "ERR-LedgerUnavailable" },
      }),
      hints: () => ledger.backend.log.hints(),
    };
    await expect(reader(ledger, { store, log: unavailable }).step()).rejects.toBeInstanceOf(
      LedgerReadError,
    );
    expect(await reader(ledger, { store }).position()).toEqual({
      cursor: LOG_START,
      nextSequence: 0,
    });
  });

  test("AD-17: a hint wakes the background reader long before its poll interval", async ({
    ledger,
  }) => {
    await history(ledger, 1);
    const { store } = await database();
    const background = reader(ledger, { store, pollInterval: 60_000 });
    background.start();
    await vi.waitFor(async () => expect((await background.position()).nextSequence).toBe(4), {
      timeout: 20_000,
    });

    await ledger.issue(
      await ledger.createEvent(0x03),
      zoneId(0x7a),
      1,
      ledger.organiser.signer.account,
    );
    await vi.waitFor(async () => expect((await background.position()).nextSequence).toBe(6), {
      timeout: 20_000,
    });
  });

  test("AD-17: a lost hint costs latency, never data", async ({ ledger }) => {
    await history(ledger, 1);
    const { store } = await database();
    const errors: unknown[] = [];
    const background = reader(ledger, {
      store,
      log: withoutHints(ledger.backend.log),
      pollInterval: 50,
      onError: (error) => errors.push(error),
    });
    background.start();
    await ledger.createEvent(0x04);
    await vi.waitFor(async () => expect((await background.position()).nextSequence).toBe(5), {
      timeout: 20_000,
    });
    await background.stop();
    expect(errors).toEqual([]);
  });

  test("the background reader retries after a failure and catches up", async ({ ledger }) => {
    await history(ledger, 2);
    const { store } = await database();
    let refusals = 2;
    const errors: unknown[] = [];
    const flaky: LogReader = {
      read: (from, limit) =>
        refusals-- > 0
          ? Promise.resolve({ ok: false, error: { code: "ERR-LedgerUnavailable" } })
          : ledger.backend.log.read(from, limit),
      hints: () => ledger.backend.log.hints(),
    };
    const background = reader(ledger, {
      store,
      log: flaky,
      onError: (error) => errors.push(error),
    });
    background.start();
    await vi.waitFor(async () => expect((await background.position()).nextSequence).toBe(5), {
      timeout: 20_000,
    });
    await background.stop();
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeInstanceOf(LedgerReadError);
  });
});
