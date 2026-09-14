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
import type { Signer } from "@ticketto/sdk";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { RelayDerivedCopy } from "./derived.js";

export interface SponsorRelayOptions {
  /** The sponsor account's `p256` signer (`kmsP256Signer`). */
  readonly sponsor: Signer;
  readonly derived: RelayDerivedCopy;
}

export function buildSponsorRelay(
  { sponsor, derived }: SponsorRelayOptions,
  options: FastifyServerOptions = {},
): FastifyInstance {
  const app = Fastify(options);

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
