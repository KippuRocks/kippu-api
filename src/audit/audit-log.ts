import type { CommandKind, Cursor, OperationId, TickettoErrorCode } from "@ticketto/sdk";
import type { ActingPrincipal } from "../auth/ports.js";
import type { Store } from "../store/store.js";

/** What caused a relayed write: the request, and who made it. */
export interface RelayRequest {
  readonly requestId: string;
  /** A session's principal, or Kippu itself acting for the organiser who arranged the write. */
  readonly principal: ActingPrincipal;
}

/** Written before a relayed write is signed (`NFR-7`, `F-020` plan §5.3). */
export interface AuditEntry extends RelayRequest {
  readonly operationId: OperationId;
  readonly commandKind: CommandKind;
}

/** How a relayed write ended. */
export type AuditOutcome =
  | { readonly outcome: "settled"; readonly cursor: Cursor }
  | { readonly outcome: "rejected"; readonly errorCode: TickettoErrorCode }
  /** The submission failed without a ledger verdict. */
  | { readonly outcome: "failed" };

export interface AuditRow extends AuditEntry {
  readonly recordedAt: Date;
  readonly outcome: "pending" | AuditOutcome["outcome"];
  readonly receiptCursor: Cursor | null;
  readonly errorCode: TickettoErrorCode | null;
  readonly completedAt: Date | null;
}

export interface AuditLog {
  /** Records a write about to be signed. Fails if the operation is already recorded. */
  record(entry: AuditEntry): Promise<void>;
  /** Records how a recorded write ended. A write's outcome is recorded once. */
  complete(operationId: OperationId, outcome: AuditOutcome): Promise<void>;
  /** The row for an operation, or `null`. */
  find(operationId: OperationId): Promise<AuditRow | null>;
}

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditError";
  }
}

interface Row {
  request_id: string;
  principal_kind: ActingPrincipal["kind"];
  organiser_id: string | null;
  operator_id: string | null;
  session_id: string | null;
  holder_account: string | null;
  reviewer_id: string | null;
  operation_id: string;
  command_kind: string;
  recorded_at: Date;
  outcome: AuditRow["outcome"];
  receipt_cursor: string | null;
  error_code: string | null;
  completed_at: Date | null;
}

type PrincipalColumns = [
  string,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
];

function principalColumns(principal: ActingPrincipal): PrincipalColumns {
  switch (principal.kind) {
    case "anonymous":
      return ["anonymous", null, null, null, null, null];
    case "organiser":
      return ["organiser", principal.organiserId, null, principal.sessionId, null, null];
    case "operator":
      return [
        "operator",
        principal.organiserId,
        principal.operatorId,
        principal.sessionId,
        null,
        null,
      ];
    case "holder":
      return ["holder", null, null, principal.sessionId, principal.account, null];
    case "reviewer":
      return ["reviewer", null, null, principal.sessionId, null, principal.reviewerId];
    case "system":
      // No session: attributed to the organiser who arranged the write; the request id
      // names the task (`scheduled-finish:<schedule id>`).
      return ["system", principal.organiserId, null, null, null, null];
  }
}

function principalOf(row: Row): ActingPrincipal {
  switch (row.principal_kind) {
    case "organiser":
      return {
        kind: "organiser",
        organiserId: row.organiser_id as string,
        sessionId: row.session_id as string,
      };
    case "operator":
      return {
        kind: "operator",
        organiserId: row.organiser_id as string,
        operatorId: row.operator_id as string,
        sessionId: row.session_id as string,
      };
    case "holder":
      return {
        kind: "holder",
        account: row.holder_account as string,
        sessionId: row.session_id as string,
      };
    case "reviewer":
      return {
        kind: "reviewer",
        reviewerId: row.reviewer_id as string,
        sessionId: row.session_id as string,
      };
    case "system":
      return {
        kind: "system",
        organiserId: row.organiser_id as string,
        task: row.request_id.split(":")[0] as "scheduled-finish",
      };
    default:
      return { kind: "anonymous" };
  }
}

export function createAuditLog(store: Store, now: () => Date = () => new Date()): AuditLog {
  return {
    async record({ requestId, principal, operationId, commandKind }) {
      const [kind, organiserId, operatorId, sessionId, holderAccount, reviewerId] =
        principalColumns(principal);
      try {
        await store.query(
          `INSERT INTO audit_log
             (request_id, principal_kind, organiser_id, operator_id, session_id, holder_account,
              reviewer_id, operation_id, command_kind, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            requestId,
            kind,
            organiserId,
            operatorId,
            sessionId,
            holderAccount,
            reviewerId,
            operationId,
            commandKind,
            now(),
          ],
        );
      } catch (error) {
        if ((error as { code?: unknown }).code === "23505") {
          throw new AuditError(`operation ${operationId} is already recorded`);
        }
        throw error;
      }
    },

    async complete(operationId, result) {
      const updated = await store.query(
        `UPDATE audit_log SET outcome = $2, receipt_cursor = $3, error_code = $4, completed_at = $5
         WHERE operation_id = $1 AND outcome = 'pending'`,
        [
          operationId,
          result.outcome,
          result.outcome === "settled" ? result.cursor : null,
          result.outcome === "rejected" ? result.errorCode : null,
          now(),
        ],
      );
      if (updated.rowCount !== 1) {
        throw new AuditError(`operation ${operationId} has no pending audit row`);
      }
    },

    async find(operationId) {
      const result = await store.query<Row>(
        `SELECT request_id, principal_kind, organiser_id, operator_id, session_id, holder_account, reviewer_id, operation_id, command_kind,
                recorded_at, outcome, receipt_cursor, error_code, completed_at
         FROM audit_log WHERE operation_id = $1`,
        [operationId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        requestId: row.request_id,
        principal: principalOf(row),
        operationId: row.operation_id as OperationId,
        commandKind: row.command_kind as CommandKind,
        recordedAt: row.recorded_at,
        outcome: row.outcome,
        receiptCursor: row.receipt_cursor as Cursor | null,
        errorCode: row.error_code as TickettoErrorCode | null,
        completedAt: row.completed_at,
      };
    },
  };
}
