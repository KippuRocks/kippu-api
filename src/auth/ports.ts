import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "./webauthn-json.js";

/**
 * Who a request acts as (`F-020` plan §5.1). Holders join in `T-020-06` and the
 * anonymous principal in `T-020-09`.
 *
 * This module is imported by the tRPC context, whose type is published in
 * `@kippu/api`: it may import only modules that import nothing at runtime.
 */
export type Principal = OrganiserPrincipal | OperatorPrincipal;

export interface OrganiserPrincipal {
  readonly kind: "organiser";
  readonly organiserId: string;
  readonly sessionId: string;
}

/**
 * An operator acts under an organiser. Kippu alone knows who they are; the
 * ledger never does (`REQ-OP-1`).
 */
export interface OperatorPrincipal {
  readonly kind: "operator";
  readonly operatorId: string;
  readonly organiserId: string;
  readonly sessionId: string;
}

/** A bearer token and when it stops working. The token is shown exactly once. */
export interface IssuedSession {
  readonly token: string;
  /** ISO 8601. */
  readonly expiresAt: string;
}

export interface Organiser {
  readonly id: string;
  readonly email: string;
}

export interface Operator {
  readonly id: string;
  readonly organiserId: string;
}

/** The first half of a WebAuthn ceremony: a challenge to sign. */
export interface SignUpChallenge {
  readonly ceremonyId: string;
  readonly options: PublicKeyCredentialCreationOptionsJSON;
}

export interface SignInChallenge {
  readonly ceremonyId: string;
  readonly options: PublicKeyCredentialRequestOptionsJSON;
}

export interface OrganiserSession {
  readonly session: IssuedSession;
  readonly organiser: Organiser;
}

export interface OperatorSession {
  readonly session: IssuedSession;
  readonly operator: Operator;
}

/** What a principal learns about its own session. */
export interface SessionInfo {
  readonly principal: Principal;
  /** ISO 8601. */
  readonly expiresAt: string;
}

export type AuthFailure =
  /** The email already has an organiser account. */
  | "email-taken"
  /** No organiser account has this email. */
  | "unknown-organiser"
  /** The ceremony is unknown, already used, or expired. */
  | "ceremony-expired"
  /** The passkey did not verify. */
  | "credential-rejected"
  /** The enrolment code is unknown, already redeemed, or expired. */
  | "enrolment-code-rejected"
  /** The input is malformed. */
  | "invalid-input";

export class AuthError extends Error {
  readonly failure: AuthFailure;

  constructor(failure: AuthFailure, message: string = failure) {
    super(message);
    this.name = "AuthError";
    this.failure = failure;
  }
}

/**
 * Organiser and operator authentication, and sessions (`T-020-05`).
 *
 * Organisers sign up with an email — an identifier only, not verified in V0 —
 * and one passkey on Kippu's login RP id, which is never the holder
 * credential's RP id. Operators redeem a one-time enrolment code their
 * organiser issued (`F-024`). Either way the result is an opaque bearer token,
 * stored hashed.
 */
export interface Auth {
  beginOrganiserSignUp(email: string): Promise<SignUpChallenge>;
  completeOrganiserSignUp(
    ceremonyId: string,
    credential: RegistrationResponseJSON,
  ): Promise<OrganiserSession>;
  beginOrganiserSignIn(email: string): Promise<SignInChallenge>;
  completeOrganiserSignIn(
    ceremonyId: string,
    credential: AuthenticationResponseJSON,
  ): Promise<OrganiserSession>;
  redeemOperatorEnrolmentCode(code: string): Promise<OperatorSession>;
  /** The live session a bearer token names, or `null`. */
  authenticate(token: string): Promise<SessionInfo | null>;
  signOut(sessionId: string): Promise<void>;
}

/** The services procedures reach through their context. */
export interface Services {
  readonly auth: Auth;
}
