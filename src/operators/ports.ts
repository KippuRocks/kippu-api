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

/**
 * Why an operator request was refused, in `error.data.reason`. A platform
 * reason, never a §10 code.
 *
 * - `unknown-operator` — no operator of the signed-in organiser has this id.
 * - `unknown-grant` — no grant of the signed-in organiser has this id.
 */
export type OperatorRefusal = "unknown-operator" | "unknown-grant";

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
}
