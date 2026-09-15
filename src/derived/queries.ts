import type {
  AccountId,
  AttendancePolicy,
  ClassId,
  Count,
  CredentialId,
  Discriminator,
  EventId,
  EventStatus,
  Event as LedgerEvent,
  Placement,
  Position,
  Provenance,
  Registration,
  Ticket,
  TicketId,
  Timestamp,
  Zone,
  ZoneId,
} from "@ticketto/sdk";
import type { Store } from "../store/store.js";
import { type CopyFreshness, freshnessOf, HEAD_SQL, type HeadColumns } from "./freshness.js";

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

/**
 * A read response: the result, and how far the copy had read the log when it
 * was read — in the same statement, so the two always agree (`NFR-11`).
 */
export interface DerivedRead<T> {
  readonly result: T;
  readonly freshness: CopyFreshness;
}

/** An event as the copy holds it: its ledger facts, and the metadata locator the ledger records for it. */
export interface ProjectedEvent extends Projected<LedgerEvent> {
  /** The stable locator `createEvent` recorded (`REQ-MD-1`); `null` when it recorded none. */
  readonly metadataLocator: string | null;
}

/** Reads the projections: events, tickets, holdings and attendance. */
export interface DerivedQueries {
  event(id: EventId): Promise<DerivedRead<ProjectedEvent | null>>;
  /** Every event an account owns on the ledger, most recently created first. */
  eventsOwnedBy(account: AccountId): Promise<DerivedRead<readonly ProjectedEvent[]>>;
  /**
   * One page of the events on sale: `Active` in the copy, with at least one
   * `Purchased` class Kippu defines for them. Most recently created first; each
   * with its place in that order, to continue after (`T-025-10`).
   */
  eventsOnSale(
    limit: number,
    after: EventPosition | null,
  ): Promise<
    DerivedRead<readonly { readonly event: ProjectedEvent; readonly position: EventPosition }[]>
  >;
  ticket(id: TicketId): Promise<DerivedRead<Projected<Ticket> | null>>;
  /** Every ticket an account holds, ordered by event, then ticket. */
  holdings(account: AccountId): Promise<DerivedRead<readonly Projected<Ticket>[]>>;
  /** A ticket's recorded attendances; `null` before its first. */
  attendance(ticket: TicketId): Promise<DerivedRead<Projected<Attendance> | null>>;
  /**
   * The registration of `credential`, if the copy holds it registered to
   * `account`; `null` otherwise — as the ledger's `getCredential` answers
   * (`REQ-CP-6`, `T-025-09`).
   */
  credential(
    account: AccountId,
    credential: CredentialId,
  ): Promise<DerivedRead<Projected<Registration> | null>>;
  /**
   * The transfers of `ticket` the ledger recorded at or after `from` and at or
   * before `until` (ledger clock, ms), in log order.
   */
  transfers(
    ticket: TicketId,
    from: Timestamp,
    until: Timestamp,
  ): Promise<DerivedRead<readonly Projected<Transfer>[]>>;
  /** Every credential registered to `account`, in registration order. */
  credentials(account: AccountId): Promise<DerivedRead<readonly Projected<RegisteredCredential>[]>>;
}

/** A transfer the ledger recorded. */
export interface Transfer {
  readonly event: EventId;
  readonly ticket: TicketId;
  readonly from: AccountId;
  readonly to: AccountId;
  readonly recordedAt: Timestamp;
}

interface TransferRow {
  id: string;
  event_id: string;
  ticket_id: string;
  from_holder: string;
  to_holder: string;
  recorded_at: string;
  sequence: string;
}

/** A credential registered to an account. */
export interface RegisteredCredential {
  readonly account: AccountId;
  readonly credential: CredentialId;
  readonly registration: Registration;
}

interface CredentialRow {
  id: string;
  account: string;
  credential: string;
  registration: Buffer;
  sequence: string;
}

function credentialOf(row: CredentialRow): Projected<RegisteredCredential> {
  return projected(
    {
      account: row.account as AccountId,
      credential: row.credential as CredentialId,
      registration: new Uint8Array(row.registration) as Registration,
    },
    row.sequence,
  );
}

/** Where an event sits in creation order: the log sequence of its creation, then its id. */
export interface EventPosition {
  readonly created: number;
  readonly id: EventId;
}

interface EventRow {
  id: string;
  owner: string;
  status: EventStatus;
  max_capacity: string | null;
  issued: string;
  zones: { id: string; kind: Zone["kind"] }[];
  metadata_locator: string | null;
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

function eventOf(row: EventRow): ProjectedEvent {
  return {
    ...projected(
      {
        id: row.id as EventId,
        owner: row.owner as AccountId,
        status: row.status,
        maxCapacity: nullableInt(row.max_capacity),
        issued: int(row.issued),
        zones: row.zones.map(({ id, kind }) => ({ id: id as ZoneId, kind })),
      },
      row.sequence,
    ),
    metadataLocator: row.metadata_locator,
  };
}

const EVENT_COLUMNS =
  "e.id, e.owner, e.status, e.max_capacity, e.issued, e.zones, e.metadata_locator, e.sequence";

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

const TICKET_COLUMNS = `t.id, t.event_id, t.holder, t.class_id, t.provenance, t.zone_id,
  t.placement_kind, t.position, t.discriminator, t.policy_kind, t.policy_max, t.policy_until,
  t.cannot_resale, t.cannot_transfer, t.attendances, t.sequence`;

/** Nullable projection columns, joined onto the head so a miss still says how fresh it is. */
type Joined<Row> = HeadColumns & { [Column in keyof Row]: Row[Column] | null };

/**
 * Runs `sql` — the head, `LEFT JOIN`ed with a projection on `id` — and answers
 * with its rows (none when the join found nothing) and the freshness.
 */
async function read<Row>(
  store: Store,
  sql: string,
  values: readonly unknown[],
): Promise<{ rows: Row[]; freshness: CopyFreshness }> {
  const result = await store.query<Joined<Row & { id: string }>>(
    `WITH head AS (${HEAD_SQL}) ${sql}`,
    values as unknown[],
  );
  const first = result.rows[0];
  if (first === undefined) {
    throw new Error("the derived reader's cursor row is missing; is the store migrated?");
  }
  const rows = result.rows.filter((row) => row.id !== null) as unknown as Row[];
  return { rows, freshness: freshnessOf(first) };
}

export function createDerivedQueries(store: Store): DerivedQueries {
  return {
    async event(id) {
      const { rows, freshness } = await read<EventRow>(
        store,
        `SELECT head.*, ${EVENT_COLUMNS} FROM head LEFT JOIN derived_events e ON e.id = $1`,
        [id],
      );
      const row = rows[0];
      return { result: row === undefined ? null : eventOf(row), freshness };
    },
    async eventsOwnedBy(account) {
      const { rows, freshness } = await read<EventRow>(
        store,
        `SELECT head.*, ${EVENT_COLUMNS}
         FROM head
         LEFT JOIN derived_events e ON e.owner = $1
         LEFT JOIN LATERAL (
           SELECT min(l.sequence) AS created FROM derived_log l WHERE l.event_id = e.id
         ) c ON true
         ORDER BY c.created DESC, e.id`,
        [account],
      );
      return { result: rows.map(eventOf), freshness };
    },
    async eventsOnSale(limit, after) {
      // Joins Kippu's own class definitions: whether an event sells tickets is
      // Kippu data (REQ-TC-2); its status is the copy's.
      const { rows, freshness } = await read<EventRow & { created: string }>(
        store,
        `SELECT head.*, ${EVENT_COLUMNS}, s.created
         FROM head
         LEFT JOIN LATERAL (
           SELECT e.id AS event_id, l.sequence AS created
           FROM derived_events e
           JOIN derived_log l ON l.event_id = e.id AND l.event_sequence = 0
           WHERE e.status = 'Active'
             AND EXISTS (
               SELECT 1 FROM ticket_classes k WHERE k.event = e.id AND k.provenance = 'Purchased'
             )
             AND ($1::bigint IS NULL OR (l.sequence, e.id) < ($1::bigint, $2::text))
           ORDER BY l.sequence DESC, e.id DESC
           LIMIT $3
         ) s ON true
         LEFT JOIN derived_events e ON e.id = s.event_id
         ORDER BY s.created DESC, e.id DESC`,
        [after?.created ?? null, after?.id ?? null, limit],
      );
      return {
        result: rows.map((row) => ({
          event: eventOf(row),
          position: { created: int(row.created), id: row.id as EventId },
        })),
        freshness,
      };
    },
    async transfers(ticket, from, until) {
      const { rows, freshness } = await read<TransferRow>(
        store,
        `SELECT head.*, t.sequence::text AS id, t.event_id, t.ticket_id, t.from_holder, t.to_holder,
           t.recorded_at, t.sequence
         FROM head
         LEFT JOIN derived_transfers t
           ON t.ticket_id = $1 AND t.recorded_at BETWEEN $2 AND $3
         ORDER BY t.sequence`,
        [ticket, from, until],
      );
      return {
        result: rows.map((row) =>
          projected(
            {
              event: row.event_id as EventId,
              ticket: row.ticket_id as TicketId,
              from: row.from_holder as AccountId,
              to: row.to_holder as AccountId,
              recordedAt: int(row.recorded_at),
            },
            row.sequence,
          ),
        ),
        freshness,
      };
    },
    async credential(account, credential) {
      const { rows, freshness } = await read<CredentialRow>(
        store,
        `SELECT head.*, c.credential AS id, c.account, c.credential, c.registration, c.sequence
         FROM head
         LEFT JOIN derived_credentials c ON c.account = $1 AND c.credential = $2`,
        [account, credential],
      );
      const row = rows[0];
      return {
        result:
          row === undefined ? null : projected(credentialOf(row).value.registration, row.sequence),
        freshness,
      };
    },
    async credentials(account) {
      const { rows, freshness } = await read<CredentialRow>(
        store,
        `SELECT head.*, c.credential AS id, c.account, c.credential, c.registration, c.sequence
         FROM head
         LEFT JOIN derived_credentials c ON c.account = $1
         ORDER BY c.sequence, c.credential`,
        [account],
      );
      return { result: rows.map(credentialOf), freshness };
    },
    async ticket(id) {
      const { rows, freshness } = await read<TicketRow>(
        store,
        `SELECT head.*, ${TICKET_COLUMNS} FROM head LEFT JOIN derived_tickets t ON t.id = $1`,
        [id],
      );
      const row = rows[0];
      return { result: row === undefined ? null : ticketOf(row), freshness };
    },
    async holdings(account) {
      const { rows, freshness } = await read<TicketRow>(
        store,
        `SELECT head.*, ${TICKET_COLUMNS} FROM head LEFT JOIN derived_tickets t ON t.holder = $1
         ORDER BY t.event_id, t.id`,
        [account],
      );
      return { result: rows.map(ticketOf), freshness };
    },
    async attendance(ticket) {
      const { rows, freshness } = await read<AttendanceRow & { id: string }>(
        store,
        `SELECT head.*, a.ticket_id AS id, a.ticket_id, a.event_id, a.count, a.last_recorded_at,
           a.sequence
         FROM head LEFT JOIN derived_attendance a ON a.ticket_id = $1`,
        [ticket],
      );
      const row = rows[0];
      return {
        result:
          row === undefined
            ? null
            : projected(
                {
                  event: row.event_id as EventId,
                  ticket: row.ticket_id as TicketId,
                  count: int(row.count),
                  lastRecordedAt: int(row.last_recorded_at),
                },
                row.sequence,
              ),
        freshness,
      };
    },
  };
}
