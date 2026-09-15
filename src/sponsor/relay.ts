/**
 * The sponsor relay's HTTP application (`F-023` plan §5.1, `AD-18` A).
 *
 * A separate process from kippu-api's business layer: it shares no code path
 * with the API server, so a relay failure cannot take the API down, and the API
 * being down does not stop the relay (`NFR-4`). It holds the sponsor's key and
 * read-only access to the derived copy, and nothing else.
 *
 * `GET /health` is an operational endpoint: it answers only when the derived
 * copy can be read, and says how far the copy has read the ledger's log.
 */
import { issueSponsorship, type SponsoredInput } from "@kippurocks/sponsorship";
import { decodeSignedAccessPass, decodeSignedCommand } from "@ticketto/profile-v0";
import type { Cursor, Result, Signer } from "@ticketto/sdk";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { RelayDerivedCopy } from "./derived.js";
import type { Entitlements } from "./entitlements.js";

export interface SponsorRelayOptions {
  /** The sponsor account's `p256` signer (`kmsP256Signer`). */
  readonly sponsor: Signer;
  readonly derived: RelayDerivedCopy;
  readonly entitlements: Entitlements;
  /**
   * The longest a request waits for the derived copy to reach the cursor it
   * names in `after`, in ms, before answering that the copy is lagging.
   */
  readonly lagWait: number;
}

/** Notional cost of every sponsorship until the cost table (`T-023-06`): nil under the MVP backend (`REQ-SP-1b`). */
const NOTIONAL_COST = 0n;

const HEX = /^(?:[0-9a-f]{2})*$/;

/** Lower-case hex bytes: an even length, no prefix. */
function bytesOf(value: unknown): Uint8Array | null {
  return typeof value === "string" && HEX.test(value)
    ? Uint8Array.from(Buffer.from(value, "hex"))
    : null;
}

/** A C4 cursor: at most 128 characters from `A–Z a–z 0–9 . _ ~ -`. */
const CURSOR = /^[A-Za-z0-9._~-]{0,128}$/;

/**
 * The cursor a request asks the relay to wait for, if any: the receipt cursor of
 * the submitter's latest write, which gave rise to the entitlement it now uses.
 * `undefined` when absent, `null` when malformed.
 */
function afterOf(body: unknown): Cursor | undefined | null {
  if (typeof body !== "object" || body === null || !("after" in body)) return undefined;
  const { after } = body as { after: unknown };
  return typeof after === "string" && CURSOR.test(after) ? (after as Cursor) : null;
}

/** The signed input a request carries, as C4 frames it (`{ kind, bytes }`). */
function inputOf(body: unknown): Result<SponsoredInput> | null {
  if (typeof body !== "object" || body === null || !("input" in body)) return null;
  const { input } = body as { input: unknown };
  if (typeof input !== "object" || input === null) return null;
  const { kind, bytes } = input as { kind?: unknown; bytes?: unknown };
  const decoded = bytesOf(bytes);
  if (decoded === null) return null;
  if (kind === "command") return decodeSignedCommand(decoded);
  if (kind === "pass") return decodeSignedAccessPass(decoded);
  return null;
}

export function buildSponsorRelay(
  { sponsor, derived, entitlements, lagWait }: SponsorRelayOptions,
  options: FastifyServerOptions = {},
): FastifyInstance {
  const app = Fastify(options);

  app.post("/v0/sponsor", async (request, reply) => {
    const input = inputOf(request.body);
    if (input === null) {
      return reply.code(400).send({
        error: {
          code: "malformed",
          detail: 'expected { "input": { "kind": "command" | "pass", "bytes": "<hex>" } }',
        },
      });
    }
    if (!input.ok) {
      return reply.code(400).send({ error: { code: "malformed", detail: input.error.detail } });
    }
    const after = afterOf(request.body);
    if (after === null) {
      return reply
        .code(400)
        .send({ error: { code: "malformed", detail: "after must be a log cursor" } });
    }
    let decision: Awaited<ReturnType<Entitlements["decide"]>>;
    try {
      decision = await entitlements.decide(input.value);
      // A refusal the copy's lag may explain is decided again once the copy
      // reflects the submitter's receipt cursor, so an entitled input is never
      // permanently refused (REQ-SP-5, NFR-11). It is decided again even when the
      // copy already reflects the cursor: the reader may have committed that batch
      // between the first decision and the check, and a refusal read from the
      // older copy must not become final. A second refusal is.
      if (!decision.entitled && after !== undefined) {
        if (!(await derived.waitFor(after, lagWait))) {
          return reply
            .code(503)
            .header("Retry-After", "1")
            .send({
              error: {
                code: "lagging",
                detail: `the derived copy has not reached cursor "${after}" yet; retry`,
              },
            });
        }
        decision = await entitlements.decide(input.value);
      }
    } catch (error) {
      request.log.error(error, "the derived copy cannot be read");
      return reply.code(503).send({ error: { code: "unavailable" } });
    }
    if (!decision.entitled) {
      return reply
        .code(403)
        .send({ error: { code: "ERR-SponsorshipRefused", detail: decision.reason } });
    }
    const sponsorship = await issueSponsorship(sponsor, input.value, {
      notionalCost: NOTIONAL_COST,
    });
    request.log.info(
      { entitlement: decision.entitlement, notionalCost: String(NOTIONAL_COST) },
      "sponsored",
    );
    return { sponsorship: Buffer.from(sponsorship).toString("hex") };
  });

  app.get("/health", async (request, reply) => {
    try {
      const copy = await derived.current();
      return { status: "ok", sponsor: sponsor.account, derived: copy } as const;
    } catch (error) {
      request.log.error(error, "the derived copy cannot be read");
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  return app;
}
