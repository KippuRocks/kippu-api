import { randomBytes } from "node:crypto";
import pg from "pg";
import { ledgerFactsProjection } from "../../src/derived/ledger-facts.js";
import { createDerivedReader } from "../../src/derived/reader.js";
import type { Store } from "../../src/store/store.js";
import type { MemoryLedger } from "./memory-ledger.js";

/**
 * A login role of the relay's own, granted `kippu_sponsor_relay_reader` and
 * nothing else, as a deployment would create it. Returns the relay's URL for
 * the test database, and a function dropping the role.
 */
export async function relayLoginRole(
  databaseUrl: string,
): Promise<{ readonly url: string; drop(): Promise<void> }> {
  const role = `kippu_test_relay_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(12).toString("hex");
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' IN ROLE kippu_sponsor_relay_reader`,
    );
  } finally {
    await admin.end();
  }
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  return {
    url: url.toString(),
    async drop() {
      const client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(`DROP ROLE IF EXISTS ${role}`);
      } finally {
        await client.end();
      }
    },
  };
}

/** Brings the derived copy up to date with a memory ledger's log. */
export async function catchUpDerivedCopy(store: Store, ledger: MemoryLedger): Promise<void> {
  const reader = createDerivedReader({
    store,
    log: ledger.kippu.log,
    projections: [ledgerFactsProjection(ledger.kippu)],
    onError: () => {},
  });
  await reader.catchUp();
}
