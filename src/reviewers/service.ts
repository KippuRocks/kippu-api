import { randomBytes, randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { IssuedSession } from "../auth/ports.js";
import {
  CEREMONY_MS,
  hashSecret,
  type LoginRelyingParty,
  normaliseEmail,
} from "../auth/service.js";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "../auth/webauthn-json.js";
import type { Store } from "../store/store.js";
import {
  type CreatedReviewer,
  type DisabledReviewer,
  type ReviewerAuth,
  ReviewerAuthError,
  type ReviewerSession,
} from "./ports.js";

const HOUR_MS = 60 * 60 * 1000;

/** A reviewer session's lifetime (`F-021` plan §5.4): 12 hours, as an organiser's. */
export const REVIEWER_SESSION_MS = 12 * HOUR_MS;

/** How long a reviewer's enrolment code may be redeemed. */
export const REVIEWER_ENROLMENT_CODE_MS = 72 * HOUR_MS;

const RP_NAME = "Kippu operations";

/** What the deployment's command line does with reviewers: never reachable over HTTP. */
export interface ReviewerAdministration {
  /** Creates a reviewer and issues a one-time enrolment code. Refuses an email already used. */
  create(email: string): Promise<CreatedReviewer>;
  /** Issues a new enrolment code for an enabled reviewer, voiding any unredeemed one. */
  reissueCode(email: string): Promise<CreatedReviewer>;
  /** Disables a reviewer: their sessions end, their codes are void, and they cannot sign in. */
  disable(email: string): Promise<DisabledReviewer>;
}

export interface ReviewersOptions {
  readonly store: Store;
  /** Kippu's login relying party: the organiser passkeys' RP id, never the holder credential's. */
  readonly relyingParty: LoginRelyingParty;
  readonly now?: () => Date;
}

interface CeremonyRow {
  readonly challenge: string;
  readonly reviewer_id: string;
  readonly email: string;
  readonly code_hash: Buffer | null;
}

interface PasskeyRow {
  readonly credential_id: string;
  readonly public_key: Buffer;
  readonly sign_count: string;
  readonly transports: string[];
}

/**
 * Reviewer accounts (`T-021-16`; `REQ-EV-6`, `NFR-7`; `F-021` plan §5.4). A
 * reviewer is its own account kind, never an organiser. The command line creates
 * one and issues a one-time enrolment code; the reviewer redeems it with their
 * email and a passkey on the login RP id, exactly as an organiser signs up, and
 * signs in later with that passkey. Sessions last 12 hours. Disabling a reviewer
 * ends their sessions at once: the session check refuses a disabled reviewer's.
 */
export function createReviewers(options: ReviewersOptions): ReviewerAuth & ReviewerAdministration {
  const { store, relyingParty, now = () => new Date() } = options;
  const expectedOrigin = [...relyingParty.origins];

  const issueCode = async (
    db: Pick<Store, "query">,
    reviewerId: string,
  ): Promise<{ code: string; expiresAt: Date }> => {
    const code = randomBytes(24).toString("base64url");
    const expiresAt = new Date(now().getTime() + REVIEWER_ENROLMENT_CODE_MS);
    await db.query(
      `UPDATE reviewer_enrolment_codes SET voided_at = $2
       WHERE reviewer_id = $1 AND redeemed_at IS NULL AND voided_at IS NULL`,
      [reviewerId, now()],
    );
    await db.query(
      `INSERT INTO reviewer_enrolment_codes (code_hash, reviewer_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4)`,
      [hashSecret(code), reviewerId, expiresAt, now()],
    );
    return { code, expiresAt };
  };

  const issueSession = async (
    db: Pick<Store, "query">,
    reviewerId: string,
  ): Promise<IssuedSession> => {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now().getTime() + REVIEWER_SESSION_MS);
    await db.query(
      `INSERT INTO sessions (id, token_hash, principal_kind, reviewer_id, created_at, expires_at)
       VALUES ($1, $2, 'reviewer', $3, $4, $5)`,
      [randomUUID(), hashSecret(token), reviewerId, now(), expiresAt],
    );
    return { token, expiresAt: expiresAt.toISOString() };
  };

  const consumeCeremony = async (
    kind: "reviewer-enrolment" | "reviewer-sign-in",
    ceremonyId: string,
  ): Promise<CeremonyRow> => {
    const result = await store.query<CeremonyRow & { live: boolean }>(
      `DELETE FROM reviewer_ceremonies c USING reviewers r
       WHERE c.id = $1 AND c.kind = $2 AND r.id = c.reviewer_id
       RETURNING c.challenge, c.reviewer_id, r.email, c.code_hash,
                 c.expires_at > $3 AND r.disabled_at IS NULL AS live`,
      [ceremonyId, kind, now()],
    );
    const row = result.rows[0];
    if (row === undefined || !row.live) {
      throw new ReviewerAuthError("ceremony-expired", "the challenge is unknown or has expired");
    }
    return row;
  };

  const inTransaction = async <T>(work: (db: Pick<Store, "query">) => Promise<T>): Promise<T> => {
    const client = await store.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  const reviewerByEmail = async (db: Pick<Store, "query">, email: string) =>
    (
      await db.query<{ id: string; email: string; disabled_at: Date | null }>(
        "SELECT id, email, disabled_at FROM reviewers WHERE email = $1 FOR UPDATE",
        [normaliseEmail(email)],
      )
    ).rows[0];

  return {
    async create(email) {
      const normalised = normaliseEmail(email);
      return inTransaction(async (db) => {
        const id = randomUUID();
        const inserted = await db.query(
          `INSERT INTO reviewers (id, email, created_at) VALUES ($1, $2, $3)
           ON CONFLICT (email) DO NOTHING`,
          [id, normalised, now()],
        );
        if (inserted.rowCount !== 1) {
          throw new Error(`a reviewer already uses ${normalised}`);
        }
        const { code, expiresAt } = await issueCode(db, id);
        return {
          reviewer: { id, email: normalised },
          code,
          codeExpiresAt: expiresAt.toISOString(),
        };
      });
    },

    async reissueCode(email) {
      return inTransaction(async (db) => {
        const reviewer = await reviewerByEmail(db, email);
        if (reviewer === undefined || reviewer.disabled_at !== null) {
          throw new Error("no enabled reviewer uses this email");
        }
        const { code, expiresAt } = await issueCode(db, reviewer.id);
        return {
          reviewer: { id: reviewer.id, email: reviewer.email },
          code,
          codeExpiresAt: expiresAt.toISOString(),
        };
      });
    },

    async disable(email) {
      return inTransaction(async (db) => {
        const reviewer = await reviewerByEmail(db, email);
        if (reviewer === undefined) {
          throw new Error("no reviewer uses this email");
        }
        const at = now();
        await db.query(
          "UPDATE reviewers SET disabled_at = COALESCE(disabled_at, $2) WHERE id = $1",
          [reviewer.id, at],
        );
        await db.query(
          `UPDATE reviewer_enrolment_codes SET voided_at = $2
           WHERE reviewer_id = $1 AND redeemed_at IS NULL AND voided_at IS NULL`,
          [reviewer.id, at],
        );
        const ended = await db.query(
          `UPDATE sessions SET revoked_at = $2
           WHERE reviewer_id = $1 AND revoked_at IS NULL AND expires_at > $2`,
          [reviewer.id, at],
        );
        await db.query("DELETE FROM reviewer_ceremonies WHERE reviewer_id = $1", [reviewer.id]);
        return {
          reviewer: { id: reviewer.id, email: reviewer.email },
          sessionsEnded: ended.rowCount ?? 0,
        };
      });
    },

    async beginEnrolment(code, email) {
      let normalised: string;
      try {
        normalised = normaliseEmail(email);
      } catch {
        throw new ReviewerAuthError("invalid-input", "not an email address");
      }
      const found = await store.query<{ reviewer_id: string }>(
        `SELECT c.reviewer_id FROM reviewer_enrolment_codes c JOIN reviewers r ON r.id = c.reviewer_id
         WHERE c.code_hash = $1 AND c.redeemed_at IS NULL AND c.voided_at IS NULL
           AND c.expires_at > $2 AND r.disabled_at IS NULL AND r.email = $3`,
        [hashSecret(code), now(), normalised],
      );
      const reviewerId = found.rows[0]?.reviewer_id;
      if (reviewerId === undefined) {
        throw new ReviewerAuthError(
          "enrolment-code-rejected",
          "the enrolment code is unknown, used, expired, or for another email",
        );
      }
      const registration = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: relyingParty.id,
        userName: normalised,
        userDisplayName: normalised,
        userID: new TextEncoder().encode(reviewerId),
        timeout: CEREMONY_MS,
        attestationType: "none",
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      });
      const ceremonyId = randomUUID();
      await store.query(
        `INSERT INTO reviewer_ceremonies (id, kind, challenge, reviewer_id, code_hash, expires_at, created_at)
         VALUES ($1, 'reviewer-enrolment', $2, $3, $4, $5, $6)`,
        [
          ceremonyId,
          registration.challenge,
          reviewerId,
          hashSecret(code),
          new Date(now().getTime() + CEREMONY_MS),
          now(),
        ],
      );
      return { ceremonyId, options: registration as PublicKeyCredentialCreationOptionsJSON };
    },

    async completeEnrolment(ceremonyId, credential) {
      const ceremony = await consumeCeremony("reviewer-enrolment", ceremonyId);
      const verification = await verifyRegistrationResponse({
        response: credential as Parameters<typeof verifyRegistrationResponse>[0]["response"],
        expectedChallenge: ceremony.challenge,
        expectedOrigin,
        expectedRPID: relyingParty.id,
        requireUserVerification: true,
      }).catch(() => ({ verified: false as const }));
      if (!verification.verified) {
        throw new ReviewerAuthError("credential-rejected", "the passkey did not verify");
      }
      const { credential: passkey } = verification.registrationInfo;
      return inTransaction(async (db): Promise<ReviewerSession> => {
        // The code is spent once, by the first completed enrolment.
        const spent = await db.query(
          `UPDATE reviewer_enrolment_codes SET redeemed_at = $2
           WHERE code_hash = $1 AND redeemed_at IS NULL AND voided_at IS NULL AND expires_at > $2`,
          [ceremony.code_hash, now()],
        );
        if (spent.rowCount !== 1) {
          throw new ReviewerAuthError(
            "enrolment-code-rejected",
            "the enrolment code is used, expired or void",
          );
        }
        await db.query(
          `INSERT INTO reviewer_passkeys (credential_id, reviewer_id, public_key, sign_count, transports, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            passkey.id,
            ceremony.reviewer_id,
            Buffer.from(passkey.publicKey),
            passkey.counter,
            passkey.transports ?? [],
            now(),
          ],
        );
        await db.query(
          "UPDATE reviewers SET enrolled_at = COALESCE(enrolled_at, $2) WHERE id = $1",
          [ceremony.reviewer_id, now()],
        );
        const session = await issueSession(db, ceremony.reviewer_id);
        return { session, reviewer: { id: ceremony.reviewer_id, email: ceremony.email } };
      });
    },

    async beginSignIn(email) {
      let normalised: string;
      try {
        normalised = normaliseEmail(email);
      } catch {
        throw new ReviewerAuthError("invalid-input", "not an email address");
      }
      const reviewer = await store.query<{ id: string }>(
        "SELECT id FROM reviewers WHERE email = $1 AND disabled_at IS NULL AND enrolled_at IS NOT NULL",
        [normalised],
      );
      const reviewerId = reviewer.rows[0]?.id;
      if (reviewerId === undefined) {
        throw new ReviewerAuthError("unknown-reviewer", "no enabled reviewer uses this email");
      }
      const passkeys = await store.query<Pick<PasskeyRow, "credential_id" | "transports">>(
        "SELECT credential_id, transports FROM reviewer_passkeys WHERE reviewer_id = $1",
        [reviewerId],
      );
      const authentication = await generateAuthenticationOptions({
        rpID: relyingParty.id,
        timeout: CEREMONY_MS,
        userVerification: "required",
        allowCredentials: passkeys.rows.map((row) => ({
          id: row.credential_id,
          transports: row.transports as never,
        })),
      });
      const ceremonyId = randomUUID();
      await store.query(
        `INSERT INTO reviewer_ceremonies (id, kind, challenge, reviewer_id, expires_at, created_at)
         VALUES ($1, 'reviewer-sign-in', $2, $3, $4, $5)`,
        [
          ceremonyId,
          authentication.challenge,
          reviewerId,
          new Date(now().getTime() + CEREMONY_MS),
          now(),
        ],
      );
      return { ceremonyId, options: authentication as PublicKeyCredentialRequestOptionsJSON };
    },

    async completeSignIn(ceremonyId, credential) {
      const ceremony = await consumeCeremony("reviewer-sign-in", ceremonyId);
      const found = await store.query<PasskeyRow>(
        `SELECT credential_id, public_key, sign_count, transports FROM reviewer_passkeys
         WHERE credential_id = $1 AND reviewer_id = $2`,
        [credential.id, ceremony.reviewer_id],
      );
      const passkey = found.rows[0];
      if (passkey === undefined) {
        throw new ReviewerAuthError("credential-rejected", "the passkey did not verify");
      }
      const verification = await verifyAuthenticationResponse({
        response: credential as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
        expectedChallenge: ceremony.challenge,
        expectedOrigin,
        expectedRPID: relyingParty.id,
        requireUserVerification: true,
        credential: {
          id: passkey.credential_id,
          publicKey: new Uint8Array(passkey.public_key),
          counter: Number(passkey.sign_count),
          transports: passkey.transports as never,
        },
      }).catch(() => ({ verified: false as const, authenticationInfo: undefined }));
      if (!verification.verified || verification.authenticationInfo === undefined) {
        throw new ReviewerAuthError("credential-rejected", "the passkey did not verify");
      }
      const counter = verification.authenticationInfo.newCounter;
      return inTransaction(async (db): Promise<ReviewerSession> => {
        await db.query(
          "UPDATE reviewer_passkeys SET sign_count = $2, last_used_at = $3 WHERE credential_id = $1",
          [passkey.credential_id, counter, now()],
        );
        const session = await issueSession(db, ceremony.reviewer_id);
        return { session, reviewer: { id: ceremony.reviewer_id, email: ceremony.email } };
      });
    },
  };
}
