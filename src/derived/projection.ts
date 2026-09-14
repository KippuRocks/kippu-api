import type { LogRecord } from "@ticketto/sdk";
import type pg from "pg";

/**
 * The transaction a batch is applied in. Everything a projection writes for a
 * batch commits with the reader's new cursor, or not at all (`F-025` plan §5.1).
 */
export type DerivedTransaction = pg.PoolClient;

/** A log record, with its place in the deployment's total order, counting from 0 (`AD-16`). */
export interface SequencedRecord {
  readonly sequence: number;
  readonly record: LogRecord;
}

/**
 * Keeps part of the derived copy up to date from the ledger's log. Only
 * accepted inputs reach the log, so a projection applies each one's effect and
 * never judges whether it was valid: the ledger's rules already did
 * (`REQ-IX-1`, `AD-25`).
 */
export interface Projection {
  /** A name for errors and diagnostics. */
  readonly name: string;
  /**
   * Applies one record inside the batch's transaction. Throwing aborts the
   * whole batch, cursor included: a record a projection cannot apply stops the
   * reader rather than being skipped.
   */
  apply(tx: DerivedTransaction, entry: SequencedRecord): Promise<void>;
}

/** The kind of a record's entry: a command's kind, or `accessPass`. */
export function entryKind(record: LogRecord): string {
  return "command" in record.entry ? record.entry.command.kind : "accessPass";
}
