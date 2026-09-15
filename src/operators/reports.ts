import { RefusedRequest } from "../authority/errors.js";
import type { Store } from "../store/store.js";
import type {
  AdmissionReport,
  AdmissionReportInput,
  AdmissionSubmission,
  OperatorRefusal,
  OperatorsRequest,
} from "./ports.js";

/**
 * A report as stored, for `F-025`'s matching (`T-025-06`): the report, who sent
 * it, and where it sits in the order Kippu received reports.
 */
export interface StoredAdmissionReport extends AdmissionReport {
  /** Increases with every report received; page with it. */
  readonly sequence: number;
  readonly organiserId: string;
  readonly sessionId: string;
  readonly requestId: string;
}

/** Which reports to read, in the order received. Omitted filters match everything. */
export interface AdmissionReportQuery {
  readonly event?: string;
  readonly passId?: string;
  /** Only reports received after this sequence; `0` from the start. */
  readonly after?: number;
  /** At most this many; defaults to 500. */
  readonly limit?: number;
}

export interface AdmissionReportPage {
  readonly reports: readonly StoredAdmissionReport[];
  /** The last report's sequence, or `after` when there are none: where to read from next. */
  readonly next: number;
}

/**
 * Admission reports (`T-024-04`; `REQ-OP-3`): recorded from Iriguchi, and read by
 * `F-025`, which matches them against the ledger's outcomes to flag refused
 * provisional admissions. A report is evidence, never a ledger fact (`REQ-IX-1`).
 *
 * An admission presented before a revocation is still evidence (`F-024` plan
 * §5.4): a revoked grant, or an operator session revoked within the last 24
 * hours, still reports it; neither reports a pass presented afterwards.
 */
export interface AdmissionReports {
  record(
    operator: {
      readonly operatorId: string;
      readonly organiserId: string;
      readonly sessionId: string;
    },
    request: OperatorsRequest,
    input: AdmissionReportInput,
    /** Unix milliseconds of the session's revocation, or `null` for a live session. */
    sessionRevokedAt?: number | null,
  ): Promise<AdmissionReport>;
  list(query?: AdmissionReportQuery): Promise<AdmissionReportPage>;
}

export const DEFAULT_REPORT_PAGE = 500;

interface ReportRow {
  readonly seq: string;
  readonly report_id: string;
  readonly operator_id: string;
  readonly organiser_id: string;
  readonly session_id: string;
  readonly request_id: string;
  readonly event: string;
  readonly gate: string;
  readonly ticket: string;
  readonly pass_id: string;
  readonly verdict: "admitted" | "refused";
  readonly refusal: string | null;
  readonly presented_at: Date;
  readonly device_clock: Date;
  readonly submission: AdmissionSubmission["outcome"] | null;
  readonly receipt_cursor: string | null;
  readonly error_code: string | null;
  readonly received_at: Date;
}

const COLUMNS = `seq, report_id, operator_id, organiser_id, session_id, request_id, event, gate,
  ticket, pass_id, verdict, refusal, presented_at, device_clock, submission, receipt_cursor,
  error_code, received_at`;

function submissionOf(row: ReportRow): AdmissionSubmission {
  switch (row.submission) {
    case "settled":
      return { outcome: "settled", cursor: row.receipt_cursor as string };
    case "rejected":
      return { outcome: "rejected", errorCode: row.error_code as string };
    default:
      return { outcome: "failed" };
  }
}

function reportOf(row: ReportRow): StoredAdmissionReport {
  return {
    sequence: Number(row.seq),
    reportId: row.report_id,
    operator: row.operator_id,
    organiserId: row.organiser_id,
    sessionId: row.session_id,
    requestId: row.request_id,
    event: row.event,
    gate: row.gate,
    ticket: row.ticket,
    passId: row.pass_id,
    verdict:
      row.verdict === "admitted"
        ? { kind: "admitted", submission: submissionOf(row) }
        : { kind: "refused", reason: row.refusal as string },
    presentedAt: row.presented_at.getTime(),
    deviceClock: row.device_clock.getTime(),
    receivedAt: row.received_at.getTime(),
  };
}

/** What the operator sees of their report: none of the store's bookkeeping. */
function publicReport(report: StoredAdmissionReport): AdmissionReport {
  const { sequence: _s, organiserId: _o, sessionId: _session, requestId: _r, ...rest } = report;
  return rest;
}

const refusal = (reason: OperatorRefusal): OperatorRefusal => reason;

export function createAdmissionReports({
  store,
  now = () => new Date(),
}: {
  readonly store: Store;
  readonly now?: () => Date;
}): AdmissionReports {
  return {
    async record(operator, request, input, sessionRevokedAt = null) {
      // A revoked session reports only what was presented before its revocation.
      if (sessionRevokedAt !== null && !(input.presentedAt < sessionRevokedAt)) {
        throw new RefusedRequest(
          "the session was revoked before the pass was presented",
          "UNAUTHORIZED",
        );
      }
      // Ended grants count; a revoked one only for a pass presented before its revocation.
      const grants = await store.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM operator_grants
         WHERE operator_id = $1 AND organiser_id = $2 AND event = $3 AND $4 = ANY (gates)`,
        [operator.operatorId, operator.organiserId, input.event, input.gate],
      );
      if (grants.rowCount === 0) {
        throw new RefusedRequest(
          "the operator was never granted this gate of the event",
          "FORBIDDEN",
          refusal("not-granted"),
        );
      }
      const covered = grants.rows.some(
        (grant) => grant.revoked_at === null || input.presentedAt < grant.revoked_at.getTime(),
      );
      if (!covered) {
        throw new RefusedRequest(
          "the grant for this gate was revoked before the pass was presented",
          "FORBIDDEN",
          refusal("grant-revoked"),
        );
      }
      const { verdict } = input;
      const submission = verdict.kind === "admitted" ? verdict.submission : null;
      const inserted = await store.query<ReportRow>(
        `INSERT INTO admission_reports
           (report_id, operator_id, organiser_id, session_id, request_id, event, gate, ticket,
            pass_id, verdict, refusal, presented_at, device_clock, submission, receipt_cursor,
            error_code, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (report_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          input.reportId,
          operator.operatorId,
          operator.organiserId,
          operator.sessionId,
          request.requestId,
          input.event,
          input.gate,
          input.ticket,
          input.passId,
          verdict.kind,
          verdict.kind === "refused" ? verdict.reason : null,
          new Date(input.presentedAt),
          new Date(input.deviceClock),
          submission?.outcome ?? null,
          submission?.outcome === "settled" ? submission.cursor : null,
          submission?.outcome === "rejected" ? submission.errorCode : null,
          now(),
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await store.query<ReportRow>(
            `SELECT ${COLUMNS} FROM admission_reports WHERE report_id = $1 AND operator_id = $2`,
            [input.reportId, operator.operatorId],
          )
        ).rows[0];
      if (row === undefined) {
        throw new RefusedRequest(
          "another report already has this report id",
          "CONFLICT",
          refusal("report-exists"),
        );
      }
      return publicReport(reportOf(row));
    },

    async list({ event, passId, after = 0, limit = DEFAULT_REPORT_PAGE } = {}) {
      const result = await store.query<ReportRow>(
        `SELECT ${COLUMNS} FROM admission_reports
         WHERE seq > $1
           AND ($2::text IS NULL OR event = $2)
           AND ($3::text IS NULL OR pass_id = $3)
         ORDER BY seq
         LIMIT $4`,
        [after, event ?? null, passId ?? null, limit],
      );
      const reports = result.rows.map(reportOf);
      return { reports, next: reports.at(-1)?.sequence ?? after };
    },
  };
}
