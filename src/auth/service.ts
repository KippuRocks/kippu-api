import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Store } from "../store/store.js";
import {
  type Auth,
  AuthError,
  type IssuedSession,
  type OperatorSession,
  type OrganiserSession,
  type SessionInfo,
  type SignInChallenge,
  type SignUpChallenge,
} from "./ports.js";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "./webauthn-json.js";

/** Kippu's login relying party. Never the holder credential's (`F-020` plan §8). */
export interface LoginRelyingParty {
  readonly id: string;
  /** Origins a login ceremony may come from, such as Ibento's. */
  readonly origins: readonly string[];
}

export interface AuthOptions {
  readonly store: Store;
  readonly relyingParty: LoginRelyingParty;
  readonly now?: () => Date;
}

const HOUR_MS = 60 * 60 * 1000;

/** Session lifetimes, as built (`F-020` plan §5.1). */
export const ORGANISER_SESSION_MS = 12 * HOUR_MS;
export const OPERATOR_SESSION_MS = 24 * HOUR_MS;

/** How long a WebAuthn challenge may be answered. */
export const CEREMONY_MS = 5 * 60 * 1000;

const RP_NAME = "Kippu";

export function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** A deliberately loose check: the email is an identifier, not verified in V0. */
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export function normaliseEmail(email: string): string {
  const normalised = email.trim().toLowerCase();
  if (normalised.length > 320 || !EMAIL.test(normalised)) {
    throw new AuthError("invalid-input", "not an email address");
  }
  return normalised;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown }).code === "23505";
}

interface CeremonyRow {
  readonly challenge: string;
  readonly organiser_id: string;
  readonly email: string;
}

interface PasskeyRow {
  readonly credential_id: string;
  readonly organiser_id: string;
  readonly public_key: Buffer;
  readonly sign_count: string;
  readonly transports: string[];
}

export function createAuth({ store, relyingParty, now = () => new Date() }: AuthOptions): Auth {
  const expectedOrigin = [...relyingParty.origins];

  async function issueSession(
    queryable: Pick<Store, "query">,
    principal: { organiserId: string; operatorId: string | null },
    lifetimeMs: number,
  ): Promise<IssuedSession> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now().getTime() + lifetimeMs);
    await queryable.query(
      `INSERT INTO sessions (id, token_hash, principal_kind, organiser_id, operator_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        hashSecret(token),
        principal.operatorId === null ? "organiser" : "operator",
        principal.organiserId,
        principal.operatorId,
        now(),
        expiresAt,
      ],
    );
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async function openCeremony(
    kind: "organiser-sign-up" | "organiser-sign-in",
    challenge: string,
    organiserId: string,
    email: string,
  ): Promise<string> {
    const id = randomUUID();
    await store.query(
      `INSERT INTO webauthn_ceremonies (id, kind, challenge, organiser_id, email, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, kind, challenge, organiserId, email, now(), new Date(now().getTime() + CEREMONY_MS)],
    );
    return id;
  }

  /** Consumes a ceremony: whatever the answer, it cannot be answered again. */
  async function consumeCeremony(
    kind: "organiser-sign-up" | "organiser-sign-in",
    ceremonyId: string,
  ): Promise<CeremonyRow> {
    const result = await store.query<CeremonyRow>(
      `DELETE FROM webauthn_ceremonies WHERE id = $1 AND kind = $2
       RETURNING challenge, organiser_id, email, expires_at > $3 AS live`,
      [ceremonyId, kind, now()],
    );
    const row = result.rows[0] as (CeremonyRow & { live: boolean }) | undefined;
    if (row === undefined || !row.live) {
      throw new AuthError("ceremony-expired", "the sign-in challenge is unknown or has expired");
    }
    return row;
  }

  return {
    async beginOrganiserSignUp(email) {
      const normalised = normaliseEmail(email);
      const taken = await store.query("SELECT 1 FROM organisers WHERE email = $1", [normalised]);
      if (taken.rowCount !== 0) {
        throw new AuthError("email-taken", "an organiser account already uses this email");
      }
      const organiserId = randomUUID();
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: relyingParty.id,
        userName: normalised,
        userDisplayName: normalised,
        userID: new TextEncoder().encode(organiserId),
        timeout: CEREMONY_MS,
        attestationType: "none",
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      });
      const ceremonyId = await openCeremony(
        "organiser-sign-up",
        options.challenge,
        organiserId,
        normalised,
      );
      return {
        ceremonyId,
        options: options as PublicKeyCredentialCreationOptionsJSON,
      } satisfies SignUpChallenge;
    },

    async completeOrganiserSignUp(ceremonyId, credential: RegistrationResponseJSON) {
      const ceremony = await consumeCeremony("organiser-sign-up", ceremonyId);
      const verification = await verifyRegistrationResponse({
        response: credential as Parameters<typeof verifyRegistrationResponse>[0]["response"],
        expectedChallenge: ceremony.challenge,
        expectedOrigin,
        expectedRPID: relyingParty.id,
        requireUserVerification: true,
      }).catch(() => ({ verified: false as const }));
      if (!verification.verified) {
        throw new AuthError("credential-rejected", "the passkey did not verify");
      }
      const { credential: passkey } = verification.registrationInfo;

      const client = await store.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO organisers (id, email, created_at) VALUES ($1, $2, $3)", [
          ceremony.organiser_id,
          ceremony.email,
          now(),
        ]);
        await client.query(
          `INSERT INTO organiser_passkeys (credential_id, organiser_id, public_key, sign_count, transports, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            passkey.id,
            ceremony.organiser_id,
            Buffer.from(passkey.publicKey),
            passkey.counter,
            passkey.transports ?? [],
            now(),
          ],
        );
        const session = await issueSession(
          client,
          { organiserId: ceremony.organiser_id, operatorId: null },
          ORGANISER_SESSION_MS,
        );
        await client.query("COMMIT");
        return {
          session,
          organiser: { id: ceremony.organiser_id, email: ceremony.email },
        } satisfies OrganiserSession;
      } catch (error) {
        await client.query("ROLLBACK");
        if (isUniqueViolation(error)) {
          throw new AuthError("email-taken", "an organiser account already uses this email");
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async beginOrganiserSignIn(email) {
      const normalised = normaliseEmail(email);
      const organiser = await store.query<{ id: string }>(
        "SELECT id FROM organisers WHERE email = $1",
        [normalised],
      );
      const organiserId = organiser.rows[0]?.id;
      if (organiserId === undefined) {
        throw new AuthError("unknown-organiser", "no organiser account uses this email");
      }
      const passkeys = await store.query<Pick<PasskeyRow, "credential_id" | "transports">>(
        "SELECT credential_id, transports FROM organiser_passkeys WHERE organiser_id = $1",
        [organiserId],
      );
      const options = await generateAuthenticationOptions({
        rpID: relyingParty.id,
        timeout: CEREMONY_MS,
        userVerification: "required",
        allowCredentials: passkeys.rows.map((row) => ({
          id: row.credential_id,
          transports: row.transports,
        })),
      });
      const ceremonyId = await openCeremony(
        "organiser-sign-in",
        options.challenge,
        organiserId,
        normalised,
      );
      return {
        ceremonyId,
        options: options as PublicKeyCredentialRequestOptionsJSON,
      } satisfies SignInChallenge;
    },

    async completeOrganiserSignIn(ceremonyId, credential: AuthenticationResponseJSON) {
      const ceremony = await consumeCeremony("organiser-sign-in", ceremonyId);
      const found = await store.query<PasskeyRow>(
        `SELECT credential_id, organiser_id, public_key, sign_count, transports
         FROM organiser_passkeys WHERE credential_id = $1 AND organiser_id = $2`,
        [credential.id, ceremony.organiser_id],
      );
      const passkey = found.rows[0];
      if (passkey === undefined) {
        throw new AuthError("credential-rejected", "the passkey did not verify");
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
          transports: passkey.transports,
        },
      }).catch(() => ({ verified: false as const, authenticationInfo: undefined }));
      if (!verification.verified || verification.authenticationInfo === undefined) {
        throw new AuthError("credential-rejected", "the passkey did not verify");
      }

      const client = await store.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE organiser_passkeys SET sign_count = $2, last_used_at = $3 WHERE credential_id = $1",
          [passkey.credential_id, verification.authenticationInfo.newCounter, now()],
        );
        const session = await issueSession(
          client,
          { organiserId: ceremony.organiser_id, operatorId: null },
          ORGANISER_SESSION_MS,
        );
        await client.query("COMMIT");
        return {
          session,
          organiser: { id: ceremony.organiser_id, email: ceremony.email },
        } satisfies OrganiserSession;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async redeemOperatorEnrolmentCode(code) {
      const client = await store.connect();
      try {
        await client.query("BEGIN");
        const redeemed = await client.query<{ operator_id: string; organiser_id: string }>(
          `UPDATE operator_enrolment_codes AS c SET redeemed_at = $2
           FROM operators AS o
           WHERE c.code_hash = $1 AND c.redeemed_at IS NULL AND c.expires_at > $2
             AND o.id = c.operator_id
           RETURNING c.operator_id, o.organiser_id`,
          [hashSecret(code), now()],
        );
        const row = redeemed.rows[0];
        if (row === undefined) {
          await client.query("ROLLBACK");
          throw new AuthError(
            "enrolment-code-rejected",
            "the enrolment code is unknown, already used, or expired",
          );
        }
        const session = await issueSession(
          client,
          { organiserId: row.organiser_id, operatorId: row.operator_id },
          OPERATOR_SESSION_MS,
        );
        await client.query("COMMIT");
        return {
          session,
          operator: { id: row.operator_id, organiserId: row.organiser_id },
        } satisfies OperatorSession;
      } catch (error) {
        if (!(error instanceof AuthError)) {
          await client.query("ROLLBACK");
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async authenticate(token) {
      const result = await store.query<{
        id: string;
        principal_kind: "organiser" | "operator";
        organiser_id: string;
        operator_id: string | null;
        expires_at: Date;
      }>(
        `SELECT id, principal_kind, organiser_id, operator_id, expires_at FROM sessions
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
        [hashSecret(token), now()],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      const expiresAt = row.expires_at.toISOString();
      if (row.principal_kind === "operator" && row.operator_id !== null) {
        return {
          principal: {
            kind: "operator",
            operatorId: row.operator_id,
            organiserId: row.organiser_id,
            sessionId: row.id,
          },
          expiresAt,
        } satisfies SessionInfo;
      }
      return {
        principal: { kind: "organiser", organiserId: row.organiser_id, sessionId: row.id },
        expiresAt,
      } satisfies SessionInfo;
    },

    async signOut(sessionId) {
      await store.query(
        "UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL",
        [sessionId, now()],
      );
    },
  };
}
