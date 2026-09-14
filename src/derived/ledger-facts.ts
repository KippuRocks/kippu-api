import type {
  AccessPass,
  Command,
  EventId,
  Event as LedgerEvent,
  LogRecord,
  Result,
  Zone,
} from "@ticketto/sdk";
import type { DerivedTransaction, Projection, SequencedRecord } from "./projection.js";

/**
 * The point queries the projections need, answered by the ledger through the
 * SDK (`REQ-SDK-9`).
 */
export interface LedgerPointQueries {
  getEvent(event: EventId): Promise<Result<LedgerEvent>>;
}

/** A record the projections do not know how to apply. It stops the reader; it is never skipped. */
export class UnprojectableRecordError extends Error {
  readonly cursor: string;

  constructor(record: LogRecord, reason: string) {
    super(`cannot project the log record at cursor ${JSON.stringify(record.cursor)}: ${reason}`);
    this.name = "UnprojectableRecordError";
    this.cursor = record.cursor;
  }
}

/** The ledger could not answer a point query a projection needed. Retryable. */
export class LedgerQueryError extends Error {
  readonly code: string;

  constructor(code: string, what: string) {
    super(`the ledger answered ${code} to ${what}`);
    this.name = "LedgerQueryError";
    this.code = code;
  }
}

/**
 * Applies one write, checking it touched exactly the rows the log says exist.
 * A miss means the copy no longer follows the log: the reader stops.
 */
async function exactlyOne(
  tx: DerivedTransaction,
  record: LogRecord,
  sql: string,
  values: readonly unknown[],
): Promise<void> {
  const result = await tx.query(sql, values as unknown[]);
  if (result.rowCount !== 1) {
    throw new UnprojectableRecordError(
      record,
      `expected to change one row, changed ${result.rowCount ?? 0}`,
    );
  }
}

async function applyCommand(
  tx: DerivedTransaction,
  ledger: LedgerPointQueries,
  { sequence, record }: SequencedRecord,
  command: Command,
): Promise<void> {
  switch (command.kind) {
    case "createEvent": {
      // The owner is the account that signed the command. Owners never change,
      // so the ledger's answer now is its answer at this record.
      const event = await ledger.getEvent(command.event);
      if (!event.ok) {
        throw new LedgerQueryError(event.error.code, `getEvent(${command.event})`);
      }
      await exactlyOne(
        tx,
        record,
        `INSERT INTO derived_events
           (id, owner, status, max_capacity, issued, zones, metadata_locator, sequence)
         VALUES ($1, $2, 'Active', $3, 0, $4, $5, $6)`,
        [
          command.event,
          event.value.owner,
          command.capacity,
          zonesJson(command.zones),
          command.metadata,
          sequence,
        ],
      );
      return;
    }
    case "setEventStatus":
      await exactlyOne(
        tx,
        record,
        "UPDATE derived_events SET status = $2, sequence = $3 WHERE id = $1",
        [command.event, command.status, sequence],
      );
      return;
    case "setEventCapacity":
      await exactlyOne(
        tx,
        record,
        "UPDATE derived_events SET max_capacity = $2, sequence = $3 WHERE id = $1",
        [command.event, command.capacity, sequence],
      );
      return;
    case "addZone":
      await exactlyOne(
        tx,
        record,
        "UPDATE derived_events SET zones = zones || $2::jsonb, sequence = $3 WHERE id = $1",
        [command.event, zonesJson([command.zone]), sequence],
      );
      return;
    case "removeZone":
      await exactlyOne(
        tx,
        record,
        `UPDATE derived_events
         SET zones = COALESCE(
               (SELECT jsonb_agg(zone ORDER BY ordinal)
                FROM jsonb_array_elements(zones) WITH ORDINALITY AS z(zone, ordinal)
                WHERE zone->>'id' <> $2),
               '[]'::jsonb),
             sequence = $3
         WHERE id = $1`,
        [command.event, command.zone, sequence],
      );
      return;
    case "issueTicket": {
      const { placement, policy, restrictions } = command;
      await exactlyOne(
        tx,
        record,
        `INSERT INTO derived_tickets
           (id, event_id, holder, class_id, provenance, zone_id, placement_kind, position,
            discriminator, policy_kind, policy_max, policy_until, cannot_resale, cannot_transfer,
            attendances, sequence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, $15)`,
        [
          command.ticket,
          command.event,
          command.holder,
          command.class,
          command.provenance,
          command.zone,
          placement.kind,
          placement.kind === "Seated" ? placement.position : null,
          placement.kind === "Unseated" ? placement.discriminator : null,
          policy.kind,
          policy.kind === "Multiple" ? policy.max : null,
          policy.kind === "Single" ? null : policy.until,
          // `cannot_transfer` implies `cannot_resale` (`REQ-TK-2`).
          restrictions.cannotResale || restrictions.cannotTransfer,
          restrictions.cannotTransfer,
          sequence,
        ],
      );
      await exactlyOne(
        tx,
        record,
        "UPDATE derived_events SET issued = issued + 1, sequence = $2 WHERE id = $1",
        [command.event, sequence],
      );
      return;
    }
    case "transferTicket":
      await exactlyOne(
        tx,
        record,
        "UPDATE derived_tickets SET holder = $3, sequence = $4 WHERE id = $1 AND event_id = $2",
        [command.ticket, command.event, command.receiver, sequence],
      );
      return;
    case "removeRestriction": {
      // The command only ever clears the flag it names (`INV-10`).
      if (command.restriction !== "cannotResale" && command.restriction !== "cannotTransfer") {
        throw new UnprojectableRecordError(record, `unknown restriction ${command.restriction}`);
      }
      const column = command.restriction === "cannotResale" ? "cannot_resale" : "cannot_transfer";
      await exactlyOne(
        tx,
        record,
        `UPDATE derived_tickets SET ${column} = false, sequence = $3 WHERE id = $1 AND event_id = $2`,
        [command.ticket, command.event, sequence],
      );
      return;
    }
    case "registerCredential":
      // Credentials are not projected.
      return;
    default:
      throw new UnprojectableRecordError(
        record,
        `unknown command kind ${JSON.stringify((command as { kind: unknown }).kind)}`,
      );
  }
}

/** One recorded attendance: `attendances` goes up by exactly one (`INV-3`). */
async function applyAttendance(
  tx: DerivedTransaction,
  { sequence, record }: SequencedRecord,
  pass: AccessPass,
): Promise<void> {
  if (record.event === null) {
    throw new UnprojectableRecordError(record, "an access pass record names no event");
  }
  await exactlyOne(
    tx,
    record,
    `UPDATE derived_tickets SET attendances = attendances + 1, sequence = $3
     WHERE id = $1 AND event_id = $2`,
    [pass.ticket, record.event.id, sequence],
  );
  await exactlyOne(
    tx,
    record,
    `INSERT INTO derived_attendance (ticket_id, event_id, count, last_recorded_at, sequence)
     VALUES ($1, $2, 1, $3, $4)
     ON CONFLICT (ticket_id) DO UPDATE
       SET count = derived_attendance.count + 1,
           last_recorded_at = EXCLUDED.last_recorded_at,
           sequence = EXCLUDED.sequence`,
    [pass.ticket, record.event.id, record.recordedAt, sequence],
  );
}

function zonesJson(zones: readonly Zone[]): string {
  return JSON.stringify(zones.map(({ id, kind }) => ({ id, kind })));
}

/**
 * The events, tickets, holdings and attendance projections (`F-025` plan §5.2).
 *
 * Each record's effect is derived from its signed input — only accepted inputs
 * reach the log, so nothing is re-judged here (`AD-25`) — plus a point query
 * where the input does not state a fact: an event's owner.
 */
export function ledgerFactsProjection(ledger: LedgerPointQueries): Projection {
  return {
    name: "ledger facts",
    async apply(tx, entry) {
      const { entry: input } = entry.record;
      if ("command" in input) {
        await applyCommand(tx, ledger, entry, input.command);
      } else if ("pass" in input) {
        await applyAttendance(tx, entry, input.pass);
      } else {
        throw new UnprojectableRecordError(entry.record, "the entry is neither command nor pass");
      }
    },
  };
}
