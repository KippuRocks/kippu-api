import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_METADATA_PUBLIC_URL } from "../../src/metadata/config.js";
import { buildMetadataEdge } from "../../src/metadata/edge.js";
import { objectKeyOf, publishSchemas } from "../../src/metadata/schemas.js";
import { createS3MetadataStorage, type MetadataStorage } from "../../src/metadata/storage.js";
import {
  createTestBucket,
  describeWithObjectStorage,
  type TestBucket,
} from "../support/object-storage.js";

/** A page on an origin that is neither Kippu's API nor the metadata origin. */
const CLIENT_ORIGIN = "https://any-ticketto-client.example";

const EVENT_ID = "5f1d3c0a9b8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a392817060504";

/**
 * The CORS check a browser applies to a response before handing it to a page
 * (Fetch standard, "CORS check"), for a request whose credentials mode is
 * "omit": the response must allow the page's origin, or any origin with `*`.
 */
function passesCorsCheck(response: Response, origin: string, exposed: readonly string[]): boolean {
  const allowOrigin = response.headers.get("access-control-allow-origin");
  if (allowOrigin !== "*" && allowOrigin !== origin) return false;
  const exposedHeaders = (response.headers.get("access-control-expose-headers") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase());
  return exposed.every((name) => exposedHeaders.includes(name.toLowerCase()));
}

/** A cross-origin `fetch` as a page makes it: an `Origin`, and no credentials of any kind. */
function crossOriginFetch(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { credentials: "omit", headers: { origin: CLIENT_ORIGIN, ...headers } });
}

describeWithObjectStorage("metadata served from object storage", () => {
  let bucket: TestBucket;
  let storage: MetadataStorage;
  let edge: FastifyInstance;
  let edgeUrl: string;

  beforeAll(async () => {
    bucket = await createTestBucket();
    storage = createS3MetadataStorage(bucket.config);
    edge = buildMetadataEdge({ storage });
    await edge.listen({ host: "127.0.0.1", port: 0 });
    edgeUrl = `http://127.0.0.1:${(edge.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await edge?.close();
    await bucket?.drop();
  });

  /** Where the local stand-in serves what the public URL names. */
  const served = (publicUrl: string) =>
    `${edgeUrl}/${objectKeyOf(DEFAULT_METADATA_PUBLIC_URL, publicUrl)}`;

  it("REQ-MD-4: a document is fetched cross-origin with no credentials", async () => {
    const locator = `${DEFAULT_METADATA_PUBLIC_URL}/v0/events/${EVENT_ID}.json`;
    const document = await readFile(
      new URL("../../packages/metadata-schema/test/fixtures/event.json", import.meta.url),
    );
    await storage.put(objectKeyOf(DEFAULT_METADATA_PUBLIC_URL, locator), document, {
      contentType: "application/json",
    });

    const response = await crossOriginFetch(served(locator));

    expect(response.status).toBe(200);
    expect(passesCorsCheck(response, CLIENT_ORIGIN, ["ETag"])).toBe(true);
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("etag")).toMatch(/^"[^"]+"$/);
    expect(await response.json()).toEqual(JSON.parse(document.toString("utf8")));
  });

  it("REQ-MD-4: a page's preflight for a conditional read is allowed from any origin", async () => {
    const response = await fetch(`${edgeUrl}/v0/events/${EVENT_ID}.json`, {
      method: "OPTIONS",
      headers: {
        origin: CLIENT_ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "if-none-match",
      },
    });
    expect(response.status).toBe(204);
    expect(passesCorsCheck(response, CLIENT_ORIGIN, [])).toBe(true);
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("an edit keeps the locator, and a revalidating reader gets the edited document", async () => {
    const locator = `${DEFAULT_METADATA_PUBLIC_URL}/v0/classes/${"0a".repeat(32)}.json`;
    const key = objectKeyOf(DEFAULT_METADATA_PUBLIC_URL, locator);
    const encode = (name: string) => new TextEncoder().encode(JSON.stringify({ name }));

    await storage.put(key, encode("Stalls"), { contentType: "application/json" });
    const first = await crossOriginFetch(served(locator));
    const etag = first.headers.get("etag") ?? "";
    expect(await first.json()).toEqual({ name: "Stalls" });

    const unchanged = await crossOriginFetch(served(locator), { "if-none-match": etag });
    expect(unchanged.status).toBe(304);
    expect(passesCorsCheck(unchanged, CLIENT_ORIGIN, [])).toBe(true);

    await storage.put(key, encode("Stalls, row A"), { contentType: "application/json" });
    const edited = await crossOriginFetch(served(locator), { "if-none-match": etag });
    expect(edited.status).toBe(200);
    expect(edited.headers.get("etag")).not.toBe(etag);
    expect(await edited.json()).toEqual({ name: "Stalls, row A" });
  });

  it("REQ-MD-4: every schema is served cross-origin at its $id, byte for byte as published", async () => {
    const published = await publishSchemas(storage, DEFAULT_METADATA_PUBLIC_URL);
    expect(published.map(({ id }) => id).sort()).toEqual([
      "https://meta.kippu.rocks/v0/schemas/class/1.0.json",
      "https://meta.kippu.rocks/v0/schemas/event/1.0.json",
    ]);

    const require = createRequire(import.meta.url);
    for (const { id } of published) {
      const subpath = id.replace("https://meta.kippu.rocks/v0/schemas/", "");
      const file = await readFile(require.resolve(`@kippu/metadata-schema/${subpath}`));

      const response = await crossOriginFetch(served(id));
      expect(response.status).toBe(200);
      expect(passesCorsCheck(response, CLIENT_ORIGIN, [])).toBe(true);
      expect(response.headers.get("content-type")).toContain("application/schema+json");
      expect(Buffer.from(await response.arrayBuffer()).equals(file)).toBe(true);
    }
  });

  it("the bucket itself is not readable anonymously: reads go through the public path", async () => {
    const endpoint = bucket.config.endpoint ?? "";
    const response = await fetch(`${endpoint}/${bucket.config.bucket}/v0/events/${EVENT_ID}.json`);
    expect(response.status).toBe(403);
  });
});
