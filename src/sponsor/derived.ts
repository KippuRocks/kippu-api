/**
 * The sponsor relay's access to the derived copy: read only, by construction
 * and by privilege (`F-023` plan §5.1).
 *
 * - **By privilege.** The relay connects with its own login role, granted
 *   `kippu_sponsor_relay_reader` (migration `0011`): `SELECT` on the derived
 *   copy's tables and nothing else.
 * - **By construction.** Every transaction on the relay's connections is read
 *   only, so a misconfigured role still cannot write.
 *
 * The relay reads ledger facts through the same queries kippu-api uses, and
 * never treats them as authoritative: the ledger's rules still decide every
 * write (`REQ-IX-1`).
 */
import pg from "pg";
import {
  type CopyFreshness,
  freshnessOf,
  HEAD_SQL,
  type HeadColumns,
} from "../derived/freshness.js";
import { createDerivedQueries, type DerivedQueries } from "../derived/queries.js";

export interface RelayDerivedCopy {
  readonly queries: DerivedQueries;
  /** How far the copy has read the ledger's log. */
  current(): Promise<CopyFreshness>;
  close(): Promise<void>;
}

export function connectRelayDerivedCopy(databaseUrl: string): RelayDerivedCopy {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: "kippu-sponsor-relay",
    options: "-c default_transaction_read_only=on",
  });
  return {
    queries: createDerivedQueries(pool),
    async current() {
      const result = await pool.query<HeadColumns>(HEAD_SQL);
      const row = result.rows[0];
      if (row === undefined) throw new Error("the derived copy has no reader position");
      return freshnessOf(row);
    },
    close: () => pool.end(),
  };
}
