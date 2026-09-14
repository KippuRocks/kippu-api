import type { Reads } from "../derived/ports.js";
import type { Events } from "../events/ports.js";
import type { Metadata } from "../metadata/ports.js";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "./webauthn-json.js";

/**
 * Who a request acts as (`F-020` plan §5.1).
 *
 * This module is imported by the tRPC context, whose type is published in
 * `@kippu/api`: it may import only modules that import nothing at runtime.
 */
export type Principal = AnonymousPrincipal | SessionPrincipal;

/** A principal that signed in, and so holds a session. */
export type SessionPrincipal = OrganiserPrincipal | OperatorPrincipal | HolderPrincipal;

/**
 * Whoever calls with no session: a visitor browsing with no account, no keys
 * and no wallet (`REQ-MP-7`). It reaches public procedures only.
 */
export interface AnonymousPrincipal {
  readonly kind: "anonymous";
}

export const ANONYMOUS: AnonymousPrincipal = Object.freeze({ kind: "anonymous" });

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

/**
 * A holder, linked to one ledger account by proving control of a holder
 * credential registered to it. Kippu holds nothing that can sign for it
 * (`REQ-SP-4`).
 */
export interface HolderPrincipal {
  readonly kind: "holder";
  /** The ledger `AccountId`, as lower-case hex. */
  readonly account: string;
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

export interface Holder {
  readonly account: string;
}

/**
 * What a holder signs to prove control of `account` (`F-003` plan §5.4a): the
 * profile's proof-of-control payload over these fields. Bytes are lower-case hex.
 */
export interface ProofOfControlChallenge {
  readonly audience: string;
  readonly nonce: string;
  /** Milliseconds since the Unix epoch. The proof is valid strictly before it. */
  readonly expiresAt: number;
  readonly account: string;
}

export interface HolderLinkChallenge {
  readonly challengeId: string;
  readonly challenge: ProofOfControlChallenge;
}

export interface HolderSession {
  readonly session: IssuedSession;
  readonly holder: Holder;
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
  readonly principal: SessionPrincipal;
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
  /**
   * A proof of control was refused. Deliberately one failure, whichever check
   * failed: the challenge, the registration on the ledger, or the signature.
   */
  | "link-rejected"
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
 * organiser issued (`F-024`). Holders prove control of a ledger account with
 * their holder credential. Every way, the result is an opaque bearer token,
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
  /** Issues a proof-of-control challenge for a holder account (`T-020-06`). */
  beginHolderLink(account: string): Promise<HolderLinkChallenge>;
  /**
   * Verifies the holder's authorisation over the challenge against the
   * credential's registration as the ledger records it, and opens a holder
   * session. `authorisation` is the profile's authorisation bytes, as hex.
   */
  completeHolderLink(challengeId: string, authorisation: string): Promise<HolderSession>;
  /** The live session a bearer token names, or `null`. */
  authenticate(token: string): Promise<SessionInfo | null>;
  signOut(sessionId: string): Promise<void>;
}

/** The services procedures reach through their context. */
export interface Services {
  readonly auth: Auth;
  readonly events: Events;
  readonly metadata: Metadata;
  readonly derived: Reads;
}
