/**
 * Operator authorisation (`F-024`; `US-E5`): operator accounts under an
 * organiser, entirely within Kippu. The ledger never learns who an operator is
 * (`REQ-OP-1`).
 *
 * This module is imported by the tRPC context, whose type is published in
 * `@kippu/api`: it may import nothing at runtime, and names no SDK type.
 */

import type { Principal } from "../auth/ports.js";

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
 * Why an operator request was refused, in `error.data.reason`. A platform
 * reason, never a §10 code.
 *
 * - `unknown-operator` — no operator of the signed-in organiser has this id.
 */
export type OperatorRefusal = "unknown-operator";

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
}
