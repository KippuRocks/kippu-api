import type {
  AccountId,
  AttendancePolicy,
  ClassId,
  Count,
  Discriminator,
  EventId,
  EventStatus,
  Event as LedgerEvent,
  Placement,
  Position,
  Provenance,
  Ticket,
  TicketId,
  Timestamp,
  Zone,
  ZoneId,
} from "@ticketto/sdk";
import type { Store } from "../store/store.js";

/**
 * A ledger fact as Kippu's derived copy holds it. Never authoritative
 * (`REQ-IX-1`): a write is never decided from it except as a pre-check, and
 * where it disagrees with the ledger, the ledger wins (`REQ-IX-2`).
 */
export interface Projected<T> {
  readonly value: T;
  /** The log sequence of the last record that changed this fact. */
  readonly sequence: number;
  readonly authoritative: false;
}

/** Recorded attendances of one ticket (`F-025` plan §5.2). */
export interface Attendance {
  readonly event: EventId;
  readonly ticket: TicketId;
  readonly count: Count;
  /** When the ledger recorded the latest attendance, by its clock. */
  readonly lastRecordedAt: Timestamp;
}

/** Reads the projections: events, tickets, holdings and attendance. */
export interface DerivedQueries {
  event(id: EventId): Promise<Projected<LedgerEvent> | null>;
  ticket(id: TicketId): Promise<Projected<Ticket> | null>;
  /** Every ticket an account holds, ordered by event, then ticket. */
  holdings(account: AccountId): Promise<readonly Projected<Ticket>[]>;
  /** A ticket's recorded attendances; `null` before its first. */
  attendance(ticket: TicketId): Promise<Projected<Attendance> | null>;
}

interface EventRow {
  id: string;
  owner: string;
  status: EventStatus;
  max_capacity: string | null;
  issued: string;
  zones: { id: string; kind: Zone["kind"] }[];
  sequence: string;
}

interface TicketRow {
  id: string;
  event_id: string;
  holder: string;
  class_id: string;
  provenance: Provenance;
  zone_id: string;
  placement_kind: Placement["kind"];
  position: string | null;
  discriminator: string | null;
  policy_kind: AttendancePolicy["kind"];
  policy_max: string | null;
  policy_until: string | null;
  cannot_resale: boolean;
  cannot_transfer: boolean;
  attendances: string;
  sequence: string;
}

interface AttendanceRow {
  ticket_id: string;
  event_id: string;
  count: string;
  last_recorded_at: string;
  sequence: string;
}

/** A PostgreSQL `bigint`, which `pg` returns as a string. Ledger counts and times are safe integers. */
function int(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`${value} is not a safe integer`);
  }
  return parsed;
}

const nullableInt = (value: string | null) => (value === null ? null : int(value));

function projected<T>(value: T, sequence: string): Projected<T> {
  return { value, sequence: int(sequence), authoritative: false };
}

function eventOf(row: EventRow): Projected<LedgerEvent> {
  return projected(
    {
      id: row.id as EventId,
      owner: row.owner as AccountId,
      status: row.status,
      maxCapacity: nullableInt(row.max_capacity),
      issued: int(row.issued),
      zones: row.zones.map(({ id, kind }) => ({ id: id as ZoneId, kind })),
    },
    row.sequence,
  );
}

function placementOf(row: TicketRow): Placement {
  return row.placement_kind === "Seated"
    ? { kind: "Seated", position: row.position as Position }
    : { kind: "Unseated", discriminator: row.discriminator as Discriminator };
}

function policyOf(row: TicketRow): AttendancePolicy {
  switch (row.policy_kind) {
    case "Single":
      return { kind: "Single" };
    case "Multiple":
      return {
        kind: "Multiple",
        max: int(row.policy_max as string),
        until: nullableInt(row.policy_until),
      };
    case "Unlimited":
      return { kind: "Unlimited", until: nullableInt(row.policy_until) };
  }
}

function ticketOf(row: TicketRow): Projected<Ticket> {
  return projected(
    {
      id: row.id as TicketId,
      event: row.event_id as EventId,
      holder: row.holder as AccountId,
      class: row.class_id as ClassId,
      provenance: row.provenance,
      zone: row.zone_id as ZoneId,
      placement: placementOf(row),
      policy: policyOf(row),
      restrictions: { cannotResale: row.cannot_resale, cannotTransfer: row.cannot_transfer },
      attendances: int(row.attendances),
    },
    row.sequence,
  );
}

const TICKET_COLUMNS = `id, event_id, holder, class_id, provenance, zone_id, placement_kind, position,
  discriminator, policy_kind, policy_max, policy_until, cannot_resale, cannot_transfer, attendances,
  sequence`;

export function createDerivedQueries(store: Store): DerivedQueries {
  return {
    async event(id) {
      const result = await store.query<EventRow>(
        `SELECT id, owner, status, max_capacity, issued, zones, sequence
         FROM derived_events WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row === undefined ? null : eventOf(row);
    },
    async ticket(id) {
      const result = await store.query<TicketRow>(
        `SELECT ${TICKET_COLUMNS} FROM derived_tickets WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row === undefined ? null : ticketOf(row);
    },
    async holdings(account) {
      const result = await store.query<TicketRow>(
        `SELECT ${TICKET_COLUMNS} FROM derived_tickets WHERE holder = $1 ORDER BY event_id, id`,
        [account],
      );
      return result.rows.map(ticketOf);
    },
    async attendance(ticket) {
      const result = await store.query<AttendanceRow>(
        `SELECT ticket_id, event_id, count, last_recorded_at, sequence
         FROM derived_attendance WHERE ticket_id = $1`,
        [ticket],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : projected(
            {
              event: row.event_id as EventId,
              ticket: row.ticket_id as TicketId,
              count: int(row.count),
              lastRecordedAt: int(row.last_recorded_at),
            },
            row.sequence,
          );
    },
  };
}
