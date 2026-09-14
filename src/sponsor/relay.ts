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
import { issueSponsorship, type SponsoredInput } from "@kippu/sponsorship";
import { decodeSignedAccessPass, decodeSignedCommand } from "@ticketto/profile-v0";
import type { Result, Signer } from "@ticketto/sdk";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { RelayDerivedCopy } from "./derived.js";
import type { Entitlements } from "./entitlements.js";

export interface SponsorRelayOptions {
  /** The sponsor account's `p256` signer (`kmsP256Signer`). */
  readonly sponsor: Signer;
  readonly derived: RelayDerivedCopy;
  readonly entitlements: Entitlements;
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
  { sponsor, derived, entitlements }: SponsorRelayOptions,
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
    let decision: Awaited<ReturnType<Entitlements["decide"]>>;
    try {
      decision = await entitlements.decide(input.value);
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
