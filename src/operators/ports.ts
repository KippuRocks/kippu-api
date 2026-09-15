/**
 * Operator authorisation (`F-024`; `US-E5`): operator accounts under an
 * organiser, entirely within Kippu. The ledger never learns who an operator is
 * (`REQ-OP-1`).
 *
 * This module is imported by the tRPC context, whose type is published in
 * `@kippu/api`: it may import nothing at runtime, and names no SDK type.
 */

import type { OperatorPrincipal, Principal } from "../auth/ports.js";

/** The request a call acts on behalf of. */
export interface OperatorsRequest {
  readonly requestId: string;
  readonly principal: Principal;
}

/** An operator to create under the signed-in organiser. */
export interface CreateOperatorInput {
  /** The organiser's own label for the operator, such as a staff member's name. Stays in Kippu. */
  readonly name: string;
}

/** An operator, by id. */
export interface OperatorInput {
  readonly operator: string;
}

/** An operator account, as its organiser sees it. */
export interface OperatorAccount {
  readonly id: string;
  readonly name: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** How many of the operator's sessions are live: neither expired, signed out nor revoked. */
  readonly liveSessions: number;
}

/**
 * A one-time enrolment code. Iriguchi redeems it with
 * `auth.operator.redeemEnrolmentCode` for an operator session. The code is shown
 * exactly once; Kippu keeps only its SHA-256.
 */
export interface EnrolmentCode {
  readonly operator: string;
  readonly code: string;
  /** ISO 8601. The code cannot be redeemed at or after it. */
  readonly expiresAt: string;
}

/** What revoking an operator's sessions ended. */
export interface RevokedSessions {
  readonly operator: string;
  /** Live sessions revoked: every call in them is refused from now on. */
  readonly sessionsRevoked: number;
  /** Unredeemed enrolment codes voided, so none can open a new session. */
  readonly codesVoided: number;
}

/**
 * A grant to make (`F-024` plan §5.1): the operator may operate these gates of
 * the event, inside the window. The organiser must own the event.
 */
export interface GrantInput {
  readonly operator: string;
  /** The `EventId`, 64 lower-case hex characters. */
  readonly event: string;
  /** The organiser's own gate labels, such as `North door`, matched exactly. 1 to 100, distinct. */
  readonly gates: readonly string[];
  /** Unix milliseconds: the grant is active from this instant… */
  readonly from: number;
  /** …until strictly before this one, which must be later than `from`. */
  readonly until: number;
}

/** A grant, by id. */
export interface GrantIdInput {
  readonly grant: string;
}

/** Which of the organiser's grants to list; `null` filters nothing. */
export interface ListGrantsInput {
  readonly event: string | null;
  readonly operator: string | null;
}

/** A grant, as the organiser and its operator see it. */
export interface OperatorGrant {
  readonly id: string;
  readonly operator: string;
  readonly event: string;
  readonly gates: readonly string[];
  /** Unix milliseconds, inclusive. */
  readonly from: number;
  /** Unix milliseconds, exclusive. */
  readonly until: number;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601 once revoked; a revoked grant authorises nothing. */
  readonly revokedAt: string | null;
}

/** What Iriguchi checks alongside validating a pass (`AC-E5.2`): may I admit at this gate, now? */
export interface CheckInput {
  /** The `EventId`, 64 lower-case hex characters. */
  readonly event: string;
  /** The gate label, exactly as the grant names it. */
  readonly gate: string;
}

/** The signed-in operator is authorised at the gate, now. */
export interface OperatorAuthorisation {
  readonly event: string;
  readonly gate: string;
  /** The grant that authorises it. */
  readonly grant: string;
  /** Unix milliseconds: when that grant's window ends. */
  readonly until: number;
  /** Unix milliseconds: Kippu's clock when it checked, for Iriguchi's clock comparison. */
  readonly checkedAt: number;
}

/**
 * Why `operators.check` refused, in `error.data.reason`, with `FORBIDDEN`. A
 * platform reason, never a §10 code. An operator whose session was revoked or
 * ended is refused before the check, as `UNAUTHORIZED`, with no reason.
 *
 * - `grant-revoked` — the grant for this gate, now, was revoked.
 * - `before-window` — a grant for this gate starts later.
 * - `after-window` — the operator's grants for this gate have ended.
 * - `not-granted` — no grant for this gate of the event.
 */
export type CheckRefusal = "grant-revoked" | "before-window" | "after-window" | "not-granted";

/**
 * How an admission's direct submission to the ledger ended (`REQ-CL-3`): settled
 * with the receipt's log cursor, rejected with the ledger's §10 code, or failed
 * with no verdict. For an access pass the receipt's operation id is the pass id.
 */
export type AdmissionSubmission =
  | { readonly outcome: "settled"; readonly cursor: string }
  | { readonly outcome: "rejected"; readonly errorCode: string }
  | { readonly outcome: "failed" };

/**
 * What Iriguchi reports after a verdict at a gate (`F-024` plan §5.3), for
 * `F-025`'s provisional-admission flags (`REQ-OP-3`). Every time and outcome in it
 * is as the gate claims: a report is evidence for the organiser, never a ledger fact.
 */
export interface AdmissionReportInput {
  /** Chosen by Iriguchi, a UUID: a report sent again with the same id is recorded once. */
  readonly reportId: string;
  /** The `EventId`, 64 lower-case hex characters. */
  readonly event: string;
  /** The gate label, exactly as the operator's grant names it. */
  readonly gate: string;
  /** The `TicketId` the pass designates, 64 lower-case hex characters. */
  readonly ticket: string;
  /** The pass id, 32 lower-case hex characters. */
  readonly passId: string;
  /** For an admission, how its submission ended; a refusal is never submitted. */
  readonly verdict:
    | { readonly kind: "admitted"; readonly submission: AdmissionSubmission }
    | {
        readonly kind: "refused";
        /** The reason the gate showed: a §10 code, or a platform reason such as `grant-revoked`. */
        readonly reason: string;
      };
  /** Unix milliseconds: the presentation time the pass was submitted with (`presentedAt`). */
  readonly presentedAt: number;
  /** Unix milliseconds: the device's own, unadjusted clock when it sent the report. */
  readonly deviceClock: number;
}

/** A report as Kippu recorded it. */
export interface AdmissionReport extends AdmissionReportInput {
  readonly operator: string;
  /** Unix milliseconds: Kippu's clock when it first received the report. */
  readonly receivedAt: number;
}

/**
 * Why an operator request was refused, in `error.data.reason`. A platform
 * reason, never a §10 code.
 *
 * - `unknown-operator` — no operator of the signed-in organiser has this id.
 * - `unknown-grant` — no grant of the signed-in organiser has this id.
 * - `not-granted` — an admission report for a gate of an event the operator was
 *   never granted (`FORBIDDEN`).
 * - `report-exists` — another operator's report already has this report id (`CONFLICT`).
 */
export type OperatorRefusal =
  | "unknown-operator"
  | "unknown-grant"
  | "not-granted"
  | "report-exists";

/**
 * Operator accounts (`T-024-01`). Every method acts for one organiser, and
 * reaches only that organiser's operators.
 */
export interface Operators {
  create(
    organiserId: string,
    request: OperatorsRequest,
    input: CreateOperatorInput,
  ): Promise<OperatorAccount>;
  list(organiserId: string): Promise<readonly OperatorAccount[]>;
  /** Issues a new one-time enrolment code. Codes issued earlier stay valid until they expire. */
  issueEnrolmentCode(
    organiserId: string,
    request: OperatorsRequest,
    input: OperatorInput,
  ): Promise<EnrolmentCode>;
  /**
   * Revokes every live session of the operator, and voids their unredeemed
   * codes. The operator enrols again only with a code issued afterwards.
   */
  revokeSessions(
    organiserId: string,
    request: OperatorsRequest,
    input: OperatorInput,
  ): Promise<RevokedSessions>;
  /**
   * Grants an operator of the organiser gates of an event the organiser owns,
   * for a window (`T-024-02`). The event's owner is read from the ledger; nothing
   * is written to it (`AC-E5.1`).
   */
  grant(organiserId: string, request: OperatorsRequest, input: GrantInput): Promise<OperatorGrant>;
  /** The organiser's grants, oldest first. */
  listGrants(organiserId: string, input: ListGrantsInput): Promise<readonly OperatorGrant[]>;
  /**
   * Revokes a grant: it authorises nothing from the next check on. Revoking a
   * revoked grant changes nothing, and answers it as it is.
   */
  revokeGrant(
    organiserId: string,
    request: OperatorsRequest,
    input: GrantIdInput,
  ): Promise<OperatorGrant>;
  /**
   * The signed-in operator's grants that are not revoked and have not ended,
   * soonest first: the events and gates Iriguchi offers them.
   */
  myGrants(operator: OperatorPrincipal): Promise<readonly OperatorGrant[]>;
  /**
   * Whether the signed-in operator may admit at the gate of the event now
   * (`T-024-03`; `AC-E5.2`). Read from the store on every call, with no caching,
   * so a revocation refuses the next check. Refused with a {@link CheckRefusal}.
   */
  check(operator: OperatorPrincipal, input: CheckInput): Promise<OperatorAuthorisation>;
  /**
   * Records the signed-in operator's report of a verdict (`T-024-04`), at a gate
   * of an event they hold or held a grant for — revoked and ended grants included,
   * since an admission's outcome can arrive after either. Sending the same report
   * id again answers the report first recorded.
   */
  reportAdmission(
    operator: OperatorPrincipal,
    request: OperatorsRequest,
    input: AdmissionReportInput,
  ): Promise<AdmissionReport>;
}
