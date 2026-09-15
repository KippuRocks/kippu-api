/**
 * Kippu operations reviewers (`T-021-16`; `F-021` plan §5.4, "Reviewers").
 *
 * This module is imported by the tRPC context, whose type is published in
 * `@kippu/api`: it may import only modules that import nothing at runtime.
 */

import type { IssuedSession } from "../auth/ports.js";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "../auth/webauthn-json.js";

export interface Reviewer {
  readonly id: string;
  readonly email: string;
}

/** A reviewer's WebAuthn challenge: registering a passkey at enrolment, or signing in. */
export interface ReviewerEnrolmentChallenge {
  readonly ceremonyId: string;
  readonly options: PublicKeyCredentialCreationOptionsJSON;
}

export interface ReviewerSignInChallenge {
  readonly ceremonyId: string;
  readonly options: PublicKeyCredentialRequestOptionsJSON;
}

/** A reviewer's session: 12 hours, ended early by sign-out or by the reviewer's being disabled. */
export interface ReviewerSession {
  readonly session: IssuedSession;
  readonly reviewer: Reviewer;
}

/** What the deployment's command line gets back from creating a reviewer. */
export interface CreatedReviewer {
  readonly reviewer: Reviewer;
  /** The one-time enrolment code, shown this once. */
  readonly code: string;
  /** ISO 8601. */
  readonly codeExpiresAt: string;
}

/** What disabling a reviewer did. */
export interface DisabledReviewer {
  readonly reviewer: Reviewer;
  /** Sessions ended. */
  readonly sessionsEnded: number;
}

export type ReviewerAuthFailure =
  /** The enrolment code is unknown, used, expired or void, or names another email. */
  | "enrolment-code-rejected"
  /** No enabled, enrolled reviewer has this email. */
  | "unknown-reviewer"
  /** The ceremony is unknown, already used, or expired. */
  | "ceremony-expired"
  /** The passkey did not verify. */
  | "credential-rejected"
  /** The input is malformed. */
  | "invalid-input";

export class ReviewerAuthError extends Error {
  readonly failure: ReviewerAuthFailure;

  constructor(failure: ReviewerAuthFailure, message: string = failure) {
    super(message);
    this.name = "ReviewerAuthError";
    this.failure = failure;
  }
}

/** What the reviewers router reaches: enrolment and sign-in, as a reviewer does them. */
export interface ReviewerAuth {
  /** Opens a passkey registration for the reviewer whose enrolment code and email these are. */
  beginEnrolment(code: string, email: string): Promise<ReviewerEnrolmentChallenge>;
  /** Registers the passkey, spends the code, and opens a session. */
  completeEnrolment(
    ceremonyId: string,
    credential: RegistrationResponseJSON,
  ): Promise<ReviewerSession>;
  beginSignIn(email: string): Promise<ReviewerSignInChallenge>;
  completeSignIn(
    ceremonyId: string,
    credential: AuthenticationResponseJSON,
  ): Promise<ReviewerSession>;
}
