/**
 * The public read path for metadata: what a CDN in front of the object store
 * does, as a small HTTP server (`F-026` §5.3, `REQ-MD-4`, `AD-07`).
 *
 * No CDN is chosen, and none is created. This server stands in for one locally
 * and in CI, and fixes the behaviour a real CDN must be configured to match:
 *
 * - **No authentication.** A read needs no Kippu account, cookie or token, and
 *   the server never looks at one (`REQ-MD-4`).
 * - **Open CORS.** Every response allows any origin with `*`, and never allows
 *   credentials, so any Ticketto client reads documents from a page on any
 *   origin with a plain `fetch` (`AD-07`).
 * - **Cache headers.** Each object's stored `Cache-Control` — fresh for at most
 *   a minute — and its `ETag`, with `If-None-Match` answered `304`.
 * - **Read only.** Methods other than `GET`, `HEAD` and `OPTIONS` are refused.
 *
 * A URL path maps to the object key of the same path, so the object at
 * `v0/schemas/event/1.0.json` is served at
 * `<public URL>/v0/schemas/event/1.0.json`. The server serves objects and
 * nothing else: no document here references a Kippu API (`F-026` §5.3).
 */
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from "fastify";
import type { MetadataStorage, ObjectHead } from "./storage.js";

/** Headers a cross-origin script may read beyond the CORS-safelisted ones. */
const EXPOSED_HEADERS = "ETag, Content-Length, Last-Modified";

/** How long a browser may cache a preflight answer. */
const PREFLIGHT_MAX_AGE_SECONDS = 86400;

const READ_METHODS = "GET, HEAD, OPTIONS";
const READ_METHOD_NAMES = new Set(["GET", "HEAD", "OPTIONS"]);

function allowAnyOrigin(reply: FastifyReply): void {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Expose-Headers", EXPOSED_HEADERS);
}

function objectHeaders(reply: FastifyReply, head: ObjectHead): void {
  reply.header("Cache-Control", head.cacheControl);
  reply.header("ETag", head.etag);
  if (head.lastModified !== undefined) {
    reply.header("Last-Modified", head.lastModified.toUTCString());
  }
}

/** `If-None-Match` against an entity tag, with the weak comparison HTTP requires for it. */
export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
}

function keyOf(url: string): string | null {
  const path = url.split("?", 1)[0] ?? "";
  if (!path.startsWith("/")) return null;
  try {
    return decodeURIComponent(path.slice(1));
  } catch {
    return null;
  }
}

export interface MetadataEdgeOptions {
  readonly storage: MetadataStorage;
}

export function buildMetadataEdge(
  { storage }: MetadataEdgeOptions,
  options: FastifyServerOptions = {},
): FastifyInstance {
  const app = Fastify(options);

  app.addHook("onRequest", async (request, reply) => {
    allowAnyOrigin(reply);
    reply.header("X-Content-Type-Options", "nosniff");
    if (!READ_METHOD_NAMES.has(request.method)) {
      // Before any body is read.
      return reply
        .code(405)
        .header("Allow", READ_METHODS)
        .type("application/json")
        .send({ error: "method-not-allowed" });
    }
  });

  app.get("/health", async () => ({ status: "ok" }) as const);

  // Fastify answers HEAD for every GET route, without a body.
  app.get("/*", async (request, reply) => {
    const key = keyOf(request.url);
    const head = key === null ? null : await storage.head(key);
    if (key === null || head === null) {
      return reply.code(404).type("application/json").send({ error: "not-found" });
    }
    objectHeaders(reply, head);
    if (matchesIfNoneMatch(request.headers["if-none-match"], head.etag)) {
      return reply.code(304).send();
    }
    if (request.method === "HEAD") {
      reply.header("Content-Length", head.contentLength);
      return reply.type(head.contentType).send();
    }
    const object = await storage.get(key);
    if (object === null) {
      return reply.code(404).type("application/json").send({ error: "not-found" });
    }
    objectHeaders(reply, object.head);
    reply.header("Content-Length", object.head.contentLength);
    return reply.type(object.head.contentType).send(object.body);
  });

  app.options("/*", async (_request, reply) => {
    reply.header("Access-Control-Allow-Methods", READ_METHODS);
    reply.header("Access-Control-Allow-Headers", "If-None-Match, If-Modified-Since");
    reply.header("Access-Control-Max-Age", PREFLIGHT_MAX_AGE_SECONDS);
    return reply.code(204).send();
  });

  // Routed so that the hook above refuses them, rather than the not-found handler.
  app.route({
    method: ["POST", "PUT", "PATCH", "DELETE"],
    url: "/*",
    handler: async (_request, reply) => reply.code(405).send(),
  });

  return app;
}
