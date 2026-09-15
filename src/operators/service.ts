import { randomBytes, randomUUID } from "node:crypto";
import { hashSecret } from "../auth/service.js";
import { RefusedRequest } from "../authority/errors.js";
import type { Store } from "../store/store.js";
import type {
  EnrolmentCode,
  OperatorAccount,
  OperatorRefusal,
  Operators,
  RevokedSessions,
} from "./ports.js";

/**
 * How long an enrolment code may be redeemed after it is issued. `F-020` plan
 * §5.1 gives codes an expiry and sets no length: an hour covers handing a code
 * to staff and enrolling their device, and keeps a leaked code short-lived.
 */
export const ENROLMENT_CODE_MS = 60 * 60 * 1000;

/** Bytes of randomness in an enrolment code, which is sent as base64url. */
export const ENROLMENT_CODE_BYTES = 16;

export interface OperatorsOptions {
  readonly store: Store;
  readonly now?: () => Date;
}

interface OperatorRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: Date;
  readonly live_sessions: number;
}

function accountOf(row: OperatorRow): OperatorAccount {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    liveSessions: Number(row.live_sessions),
  };
}

const refusal = (reason: OperatorRefusal): OperatorRefusal => reason;

function unknownOperator(): RefusedRequest {
  return new RefusedRequest("no such operator", "NOT_FOUND", refusal("unknown-operator"));
}

/**
 * Operator accounts under an organiser (`T-024-01`; `US-E5`, `REQ-OP-1`). Nothing
 * here reaches the ledger.
 *
 * - An organiser **creates** named operators, and **lists** their own.
 * - An organiser **issues** a one-time enrolment code for one of their operators:
 *   16 random bytes, base64url, returned once and stored as a SHA-256. It expires
 *   after {@link ENROLMENT_CODE_MS}. Iriguchi redeems it for a 24-hour operator
 *   session (`T-020-05`).
 * - An organiser **revokes** an operator's sessions: every live one ends at once,
 *   and every unredeemed code is voided. Revoking a session is separate from
 *   revoking a grant (`F-020` plan §5.1); either stops admissions.
 * - An operator of another organiser, or none, is `unknown-operator`.
 */
export function createOperators({ store, now = () => new Date() }: OperatorsOptions): Operators {
  /** Fails unless the operator exists under the organiser. */
  async function assertOperator(
    queryable: Pick<Store, "query">,
    organiserId: string,
    operator: string,
  ): Promise<void> {
    const found = await queryable.query(
      "SELECT 1 FROM operators WHERE id = $1 AND organiser_id = $2 FOR UPDATE",
      [operator, organiserId],
    );
    if (found.rowCount === 0) {
      throw unknownOperator();
    }
  }

  return {
    async create(organiserId, request, { name }) {
      const id = randomUUID();
      const createdAt = now();
      await store.query(
        `INSERT INTO operators (id, organiser_id, name, created_request_id, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, organiserId, name, request.requestId, createdAt],
      );
      return { id, name, createdAt: createdAt.toISOString(), liveSessions: 0 };
    },

    async list(organiserId) {
      const result = await store.query<OperatorRow>(
        `SELECT o.id, o.name, o.created_at,
                (SELECT count(*) FROM sessions s
                 WHERE s.operator_id = o.id AND s.revoked_at IS NULL AND s.expires_at > $2
                )::int AS live_sessions
         FROM operators o
         WHERE o.organiser_id = $1
         ORDER BY o.created_at, o.id`,
        [organiserId, now()],
      );
      return result.rows.map(accountOf);
    },

    async issueEnrolmentCode(organiserId, request, { operator }) {
      const code = randomBytes(ENROLMENT_CODE_BYTES).toString("base64url");
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + ENROLMENT_CODE_MS);
      const client = await store.connect();
      try {
        await client.query("BEGIN");
        await assertOperator(client, organiserId, operator);
        await client.query(
          `INSERT INTO operator_enrolment_codes
             (code_hash, operator_id, expires_at, issued_request_id, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [hashSecret(code), operator, expiresAt, request.requestId, issuedAt],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return { operator, code, expiresAt: expiresAt.toISOString() } satisfies EnrolmentCode;
    },

    async revokeSessions(organiserId, _request, { operator }) {
      const at = now();
      const client = await store.connect();
      try {
        await client.query("BEGIN");
        await assertOperator(client, organiserId, operator);
        // Codes first, then sessions, each its own statement: a redemption racing
        // the revocation either commits before the codes are voided, and its new
        // session is seen and revoked by the second statement, or waits on the
        // code's row and then finds it voided.
        const codes = await client.query(
          `UPDATE operator_enrolment_codes SET voided_at = $2
           WHERE operator_id = $1 AND redeemed_at IS NULL AND voided_at IS NULL`,
          [operator, at],
        );
        const sessions = await client.query(
          `UPDATE sessions SET revoked_at = $2
           WHERE operator_id = $1 AND revoked_at IS NULL AND expires_at > $2`,
          [operator, at],
        );
        await client.query("COMMIT");
        return {
          operator,
          sessionsRevoked: sessions.rowCount ?? 0,
          codesVoided: codes.rowCount ?? 0,
        } satisfies RevokedSessions;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
