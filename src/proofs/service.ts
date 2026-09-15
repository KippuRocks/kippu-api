import { createHash, randomBytes as cryptoRandomBytes, randomUUID } from "node:crypto";
import type { EventId, ProofId } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import { ownedEvent } from "../events/ownership.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import { lockEventAllocations } from "../sales/allocation.js";
import type { Store } from "../store/store.js";
import { checkArtefact, type ProofArtefactStorage, proofArtefactKey } from "./artefacts.js";
import type {
  CapacityProofRequest,
  CapacityProofs,
  ProofArtefactMediaType,
  ReviewedCapacityProofRequest,
} from "./ports.js";

/** Bytes in a proof id: 128 random bits, like the other random identifiers (`AD-12`). */
export const PROOF_ID_BYTES = 16;

export interface CapacityProofsOptions {
  readonly store: Store;
  readonly authority: Pick<OrganiserAuthority, "account" | "relay">;
  readonly ledger: Pick<KippuTicketto, "getEvent" | "setEventCapacity">;
  /** Private object storage for artefacts; never the public metadata bucket. */
  readonly storage: ProofArtefactStorage;
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
}

interface Row {
  readonly id: string;
  readonly event: string;
  readonly organiser_id: string;
  readonly capacity: string | null;
  readonly artefact_key: string;
  readonly artefact_media_type: ProofArtefactMediaType;
  readonly artefact_size: number;
  readonly requested_at: Date;
  readonly status: CapacityProofRequest["status"];
  readonly reviewer_id: string | null;
  readonly decided_at: Date | null;
  readonly proof_id: string | null;
  readonly receipt_cursor: string | null;
}

const COLUMNS = `id, event, organiser_id, capacity, artefact_key, artefact_media_type,
  artefact_size, requested_at, status, reviewer_id, decided_at, proof_id, receipt_cursor`;

function requestOf(row: Row): CapacityProofRequest {
  return {
    id: row.id,
    event: row.event,
    capacity: row.capacity === null ? null : Number(row.capacity),
    artefact: { mediaType: row.artefact_media_type, size: row.artefact_size },
    status: row.status,
    requestedAt: row.requested_at.getTime(),
    decidedAt: row.decided_at === null ? null : row.decided_at.getTime(),
    proofId: row.proof_id,
    cursor: row.receipt_cursor,
  };
}

function reviewedOf(row: Row): ReviewedCapacityProofRequest {
  return { ...requestOf(row), organiserId: row.organiser_id, reviewerId: row.reviewer_id };
}

const isUniqueViolation = (error: unknown) => (error as { code?: unknown }).code === "23505";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether a capacity is an increase: a higher bound, or removing the bound
 * (`REQ-EV-7`). Bounding an event that has none is a decrease, from unbounded to
 * the bound, and needs no proof (`F-008` plan §5.7a): `events.decreaseCapacity`.
 */
function isIncrease(current: number | null, requested: number | null): boolean {
  return current !== null && (requested === null || requested > current);
}

/**
 * Capacity proofs (`T-021-08`; `US-A6`, `REQ-EV-5`, `REQ-EV-6`, `REQ-EV-7`,
 * `NFR-6`; `F-021` plan §5.4).
 *
 * 1. The organiser asks for an increase and uploads an artefact, which is stored
 *    in private object storage (`src/proofs/artefacts.ts`). Nothing reaches the
 *    ledger: an increase without approval never does.
 * 2. The request enters the review queue, one pending request per event.
 * 3. A Kippu reviewer — an account of its own kind (`T-021-16`), never an
 *    organiser — approves or rejects. The request records the reviewer, the time
 *    and the decision, next to its artefact.
 * 4. On approval, under the event's allocation lock, a random proof id is
 *    generated and `setEventCapacity` submitted with it, signed with the
 *    organiser's authority and audited as the reviewer's request (`NFR-7`). The
 *    ledger records the proof id in its log (`AC-A6.4`); Kippu records it on the
 *    request with the ledger's cursor. The ledger's refusal — `ERR-EventSealed`,
 *    say — is passed on and leaves the request pending, for the reviewer to reject.
 */
export function createCapacityProofs(options: CapacityProofsOptions): CapacityProofs {
  const { store, authority, ledger, storage } = options;
  const now = options.now ?? (() => new Date());
  const randomBytes = options.randomBytes ?? ((length: number) => cryptoRandomBytes(length));

  async function find(id: string): Promise<Row> {
    const row = UUID.test(id)
      ? (
          await store.query<Row>(`SELECT ${COLUMNS} FROM capacity_proof_requests WHERE id = $1`, [
            id,
          ])
        ).rows[0]
      : undefined;
    if (row === undefined) {
      throw new RefusedRequest("no such capacity proof request", "NOT_FOUND");
    }
    return row;
  }

  const decided = () =>
    new RefusedRequest("the request has already been decided", "CONFLICT", "decided");

  return {
    async request(organiserId, request, input) {
      const check = checkArtefact(input.artefact.mediaType, input.artefact.data);
      if (!check.ok) throw new RefusedRequest(check.reason, "BAD_REQUEST", "artefact");
      const { event } = await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      if (!isIncrease(event.maxCapacity, input.capacity)) {
        throw new RefusedRequest(
          "the capacity is not an increase: a decrease needs no proof",
          "BAD_REQUEST",
          "not-an-increase",
        );
      }
      const pending = await store.query(
        "SELECT 1 FROM capacity_proof_requests WHERE event = $1 AND status = 'pending'",
        [input.event],
      );
      if (pending.rows.length > 0) {
        throw new RefusedRequest(
          "a capacity proof request for the event is already pending",
          "CONFLICT",
          "pending",
        );
      }
      const id = randomUUID();
      const key = proofArtefactKey(id);
      await storage.put(key, check.bytes, { contentType: check.mediaType });
      try {
        const inserted = await store.query<Row>(
          `INSERT INTO capacity_proof_requests
             (id, event, organiser_id, capacity, artefact_key, artefact_media_type, artefact_size,
              artefact_sha256, request_id, requested_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING ${COLUMNS}`,
          [
            id,
            input.event,
            organiserId,
            input.capacity,
            key,
            check.mediaType,
            check.bytes.length,
            createHash("sha256").update(check.bytes).digest("hex"),
            request.requestId,
            now(),
          ],
        );
        return requestOf(inserted.rows[0] as Row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new RefusedRequest(
            "a capacity proof request for the event is already pending",
            "CONFLICT",
            "pending",
          );
        }
        throw error;
      }
    },

    async list(organiserId, input) {
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      const rows = await store.query<Row>(
        `SELECT ${COLUMNS} FROM capacity_proof_requests
         WHERE event = $1 ORDER BY requested_at DESC, id`,
        [input.event],
      );
      return rows.rows.map(requestOf);
    },

    async queue() {
      const rows = await store.query<Row>(
        `SELECT ${COLUMNS} FROM capacity_proof_requests
         WHERE status = 'pending' ORDER BY requested_at, id`,
      );
      return rows.rows.map(reviewedOf);
    },

    async artefact(input) {
      const row = await find(input.request);
      const stored = await storage.get(row.artefact_key);
      if (stored === null)
        throw new Error(`capacity proof artefact ${row.artefact_key} is missing`);
      return {
        mediaType: row.artefact_media_type,
        data: Buffer.from(stored.bytes).toString("base64"),
      };
    },

    async approve(request, input) {
      const { event } = await find(input.request);
      const client = await store.connect();
      try {
        await client.query("BEGIN");
        await lockEventAllocations(client, event);
        const row = (
          await client.query<Row>(
            `SELECT ${COLUMNS} FROM capacity_proof_requests WHERE id = $1 FOR UPDATE`,
            [input.request],
          )
        ).rows[0] as Row;
        if (row.status !== "pending") throw decided();
        const capacity = row.capacity === null ? null : Number(row.capacity);
        const proof = Buffer.from(randomBytes(PROOF_ID_BYTES)).toString("hex");
        const result = await authority.relay(row.organiser_id, request, (signer) =>
          ledger.setEventCapacity(signer, {
            event: event as EventId,
            capacity,
            proof: proof as ProofId,
          }),
        );
        if (!result.ok) {
          throw new SpecCodeError(result.error.code, result.error.detail);
        }
        const updated = await client.query<Row>(
          `UPDATE capacity_proof_requests
           SET status = 'approved', reviewer_id = $2, decision_request_id = $3, decided_at = $4,
               proof_id = $5, receipt_cursor = $6
           WHERE id = $1
           RETURNING ${COLUMNS}`,
          [
            row.id,
            request.principal.reviewerId,
            request.requestId,
            now(),
            proof,
            result.value.cursor,
          ],
        );
        await client.query("COMMIT");
        return reviewedOf(updated.rows[0] as Row);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async reject(request, input) {
      await find(input.request);
      const updated = await store.query<Row>(
        `UPDATE capacity_proof_requests
         SET status = 'rejected', reviewer_id = $2, decision_request_id = $3, decided_at = $4
         WHERE id = $1 AND status = 'pending'
         RETURNING ${COLUMNS}`,
        [input.request, request.principal.reviewerId, request.requestId, now()],
      );
      const row = updated.rows[0];
      if (row === undefined) throw decided();
      return reviewedOf(row);
    },
  };
}
