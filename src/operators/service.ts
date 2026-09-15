import { randomBytes, randomUUID } from "node:crypto";
import type { EventId } from "@ticketto/sdk";
import { hashSecret } from "../auth/service.js";
import type { OrganiserAuthority } from "../authority/authority.js";
import { RefusedRequest } from "../authority/errors.js";
import { ownedEvent } from "../events/ownership.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import type {
  EnrolmentCode,
  OperatorAccount,
  OperatorGrant,
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
  /** Reads an event's owner when a grant is made. Only ever read: grants write nothing to the ledger. */
  readonly ledger: Pick<KippuTicketto, "getEvent">;
  readonly authority: Pick<OrganiserAuthority, "account">;
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

interface GrantRow {
  readonly id: string;
  readonly operator_id: string;
  readonly event: string;
  readonly gates: string[];
  readonly valid_from: Date;
  readonly valid_until: Date;
  readonly created_at: Date;
  readonly revoked_at: Date | null;
}

const GRANT_COLUMNS =
  "id, operator_id, event, gates, valid_from, valid_until, created_at, revoked_at";

function grantOf(row: GrantRow): OperatorGrant {
  return {
    id: row.id,
    operator: row.operator_id,
    event: row.event,
    gates: row.gates,
    from: row.valid_from.getTime(),
    until: row.valid_until.getTime(),
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
  };
}

const refusal = (reason: OperatorRefusal): OperatorRefusal => reason;

function unknownOperator(): RefusedRequest {
  return new RefusedRequest("no such operator", "NOT_FOUND", refusal("unknown-operator"));
}

function unknownGrant(): RefusedRequest {
  return new RefusedRequest("no such grant", "NOT_FOUND", refusal("unknown-grant"));
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
 * - An organiser **grants** an operator gates of an event they own, for a window,
 *   and **revokes** a grant (`T-024-02`). The event's owner is read from the
 *   ledger (`REQ-IX-1`): `ERR-EventNotFound`, `ERR-NotOwner`. Nothing is written
 *   to it (`AC-E5.1`).
 * - An operator lists **their own** live and upcoming grants.
 * - An operator of another organiser, or none, is `unknown-operator`; a grant of
 *   another organiser, or none, `unknown-grant`.
 */
export function createOperators({
  store,
  ledger,
  authority,
  now = () => new Date(),
}: OperatorsOptions): Operators {
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

    async grant(organiserId, request, input) {
      const operatorFound = await store.query(
        "SELECT 1 FROM operators WHERE id = $1 AND organiser_id = $2",
        [input.operator, organiserId],
      );
      if (operatorFound.rowCount === 0) {
        throw unknownOperator();
      }
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      const result = await store.query<GrantRow>(
        `INSERT INTO operator_grants
           (id, operator_id, organiser_id, event, gates, valid_from, valid_until,
            created_request_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${GRANT_COLUMNS}`,
        [
          randomUUID(),
          input.operator,
          organiserId,
          input.event,
          input.gates,
          new Date(input.from),
          new Date(input.until),
          request.requestId,
          now(),
        ],
      );
      return grantOf(result.rows[0] as GrantRow);
    },

    async listGrants(organiserId, { event, operator }) {
      const result = await store.query<GrantRow>(
        `SELECT ${GRANT_COLUMNS} FROM operator_grants
         WHERE organiser_id = $1
           AND ($2::text IS NULL OR event = $2)
           AND ($3::uuid IS NULL OR operator_id = $3)
         ORDER BY seq`,
        [organiserId, event, operator],
      );
      return result.rows.map(grantOf);
    },

    async revokeGrant(organiserId, request, { grant }) {
      const revoked = await store.query<GrantRow>(
        `UPDATE operator_grants SET revoked_at = $3, revoked_request_id = $4
         WHERE id = $1 AND organiser_id = $2 AND revoked_at IS NULL
         RETURNING ${GRANT_COLUMNS}`,
        [grant, organiserId, now(), request.requestId],
      );
      const row =
        revoked.rows[0] ??
        (
          await store.query<GrantRow>(
            `SELECT ${GRANT_COLUMNS} FROM operator_grants WHERE id = $1 AND organiser_id = $2`,
            [grant, organiserId],
          )
        ).rows[0];
      if (row === undefined) {
        throw unknownGrant();
      }
      return grantOf(row);
    },

    async myGrants(operator) {
      const result = await store.query<GrantRow>(
        `SELECT ${GRANT_COLUMNS} FROM operator_grants
         WHERE operator_id = $1 AND organiser_id = $2 AND revoked_at IS NULL AND valid_until > $3
         ORDER BY valid_from, seq`,
        [operator.operatorId, operator.organiserId, now()],
      );
      return result.rows.map(grantOf);
    },
  };
}
