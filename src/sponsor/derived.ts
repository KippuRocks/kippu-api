/**
 * The sponsor relay's access to the derived copy: read only, by construction
 * and by privilege (`F-023` plan §5.1).
 *
 * - **By privilege.** The relay connects with its own login role, granted
 *   `kippu_sponsor_relay_reader` (migrations `0011`, `0024`, `0028`): `SELECT` on
 *   the derived copy's tables and on the organiser account ids view, and nothing
 *   else.
 * - **By construction.** Every transaction on the relay's connections is read
 *   only, so a misconfigured role still cannot write.
 *
 * The relay reads ledger facts through the same queries kippu-api uses, and
 * never treats them as authoritative: the ledger's rules still decide every
 * write (`REQ-IX-1`).
 */
import type { AccountId, Cursor } from "@ticketto/sdk";
import pg from "pg";
import {
  type CopyFreshness,
  createFreshness,
  freshnessOf,
  HEAD_SQL,
  type HeadColumns,
} from "../derived/freshness.js";
import { createDerivedQueries, type DerivedQueries } from "../derived/queries.js";

/** Which ledger accounts are Kippu organiser accounts (`REQ-OA-1`). */
export interface OrganiserAccounts {
  isOrganiserAccount(account: AccountId): Promise<boolean>;
}

export interface RelayDerivedCopy {
  readonly queries: DerivedQueries;
  /** Organiser ledger account ids, read through the relay's one view outside the copy. */
  readonly organisers: OrganiserAccounts;
  /** How far the copy has read the ledger's log. */
  current(): Promise<CopyFreshness>;
  /** Resolves `true` once the copy reflects the record at `cursor`, or `false` after `timeout` ms. */
  waitFor(cursor: Cursor, timeout: number): Promise<boolean>;
  close(): Promise<void>;
}

export function connectRelayDerivedCopy(databaseUrl: string): RelayDerivedCopy {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: "kippu-sponsor-relay",
    options: "-c default_transaction_read_only=on",
  });
  const freshness = createFreshness({ store: pool });
  return {
    queries: createDerivedQueries(pool),
    organisers: {
      async isOrganiserAccount(account) {
        const result = await pool.query(
          "SELECT 1 FROM sponsor_relay_organiser_accounts WHERE account = $1",
          [account],
        );
        return (result.rowCount ?? 0) > 0;
      },
    },
    waitFor: (cursor, timeout) => freshness.waitFor(cursor, timeout),
    async current() {
      const result = await pool.query<HeadColumns>(HEAD_SQL);
      const row = result.rows[0];
      if (row === undefined) throw new Error("the derived copy has no reader position");
      return freshnessOf(row);
    },
    async close() {
      await freshness.close();
      await pool.end();
    },
  };
}
