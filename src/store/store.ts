import pg from "pg";

/**
 * The Kippu store: Kippu's own PostgreSQL database.
 *
 * It holds Kippu facts — identity, sessions, the audit log, holds, and the
 * derived copy of the ledger. It is never authoritative for a fact §4.2
 * assigns to Ticketto (`REQ-IX-1`), and it is a separate instance from the
 * ledger service's store (`AD-20`, `REQ-SDK-9`).
 */
export type Store = pg.Pool;

export function createStore(databaseUrl: string): Store {
  return new pg.Pool({ connectionString: databaseUrl, application_name: "kippu-api" });
}
