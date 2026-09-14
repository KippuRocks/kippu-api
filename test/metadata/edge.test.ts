import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMetadataEdge, matchesIfNoneMatch } from "../../src/metadata/edge.js";
import { objectKeyOf, publishSchemas, SCHEMA_CONTENT_TYPE } from "../../src/metadata/schemas.js";
import { METADATA_CACHE_CONTROL } from "../../src/metadata/storage.js";
import { memoryMetadataStorage } from "../support/object-storage.js";

const storage = memoryMetadataStorage();
const app = buildMetadataEdge({ storage });
const documentKey =
  "v0/events/0101010101010101010101010101010101010101010101010101010101010101.json";
const document = new TextEncoder().encode('{"name":"Autumn Night Concert"}');
const origin = "https://storefront.example";

beforeAll(async () => {
  await storage.put(documentKey, document, { contentType: "application/json" });
  await publishSchemas(storage, "https://meta.kippu.rocks");
});

afterAll(async () => {
  await app.close();
});

describe("metadata edge", () => {
  it("REQ-MD-4: serves a document to any origin without credentials, with cache headers", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/${documentKey}`,
      headers: { origin },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(response.headers["access-control-expose-headers"]).toContain("ETag");
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["cache-control"]).toBe(METADATA_CACHE_CONTROL);
    expect(response.headers.etag).toMatch(/^"[^"]+"$/);
    expect(response.body).toBe('{"name":"Autumn Night Concert"}');
  });

  it("keeps edits visible within a minute: public, and fresh for at most 60 seconds", () => {
    const directives = METADATA_CACHE_CONTROL.split(",").map((directive) => directive.trim());
    expect(directives).toContain("public");
    const maxAge = Number(directives.find((d) => d.startsWith("max-age="))?.slice(8));
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(60);
    expect(directives.some((d) => /^(s-maxage|stale-while-revalidate|immutable)/.test(d))).toBe(
      false,
    );
  });

  it("answers a matching If-None-Match with 304, and an edit with the new document", async () => {
    const first = await app.inject({ method: "GET", url: `/${documentKey}` });
    const etag = String(first.headers.etag);
    const revalidated = await app.inject({
      method: "GET",
      url: `/${documentKey}`,
      headers: { origin, "if-none-match": etag },
    });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.headers["access-control-allow-origin"]).toBe("*");
    expect(revalidated.body).toBe("");

    await storage.put(documentKey, new TextEncoder().encode('{"name":"Edited"}'), {
      contentType: "application/json",
    });
    const edited = await app.inject({
      method: "GET",
      url: `/${documentKey}`,
      headers: { "if-none-match": etag },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.headers.etag).not.toBe(etag);
    expect(edited.body).toBe('{"name":"Edited"}');
  });

  it("answers HEAD with the object's headers and no body", async () => {
    const response = await app.inject({ method: "HEAD", url: `/${documentKey}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBeDefined();
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.body).toBe("");
  });

  it("answers a CORS preflight for any origin, allowing reads only", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: `/${documentKey}`,
      headers: {
        origin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "if-none-match",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["access-control-allow-methods"]).toBe("GET, HEAD, OPTIONS");
    expect(String(response.headers["access-control-allow-headers"]).toLowerCase()).toContain(
      "if-none-match",
    );
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("serves each schema at the path of its $id, as application/schema+json", async () => {
    for (const id of [
      "https://meta.kippu.rocks/v0/schemas/event/1.0.json",
      "https://meta.kippu.rocks/v0/schemas/class/1.0.json",
    ]) {
      const response = await app.inject({ method: "GET", url: new URL(id).pathname });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain(SCHEMA_CONTENT_TYPE);
      expect(JSON.parse(response.body).$id).toBe(id);
    }
  });

  it("answers 404 for a missing object or a key outside the store's key space", async () => {
    for (const url of ["/v0/events/missing.json", "/", "/v0/../secret", "/v0/a%2F..%2Fb"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
    }
  });

  it("refuses every write method", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url: `/${documentKey}`, payload: "{}" });
      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("GET, HEAD, OPTIONS");
    }
  });

  it("compares If-None-Match weakly, and accepts a list or *", () => {
    expect(matchesIfNoneMatch('"a"', '"a"')).toBe(true);
    expect(matchesIfNoneMatch('W/"a"', '"a"')).toBe(true);
    expect(matchesIfNoneMatch('"b", "a"', '"a"')).toBe(true);
    expect(matchesIfNoneMatch("*", '"a"')).toBe(true);
    expect(matchesIfNoneMatch('"b"', '"a"')).toBe(false);
    expect(matchesIfNoneMatch(undefined, '"a"')).toBe(false);
  });

  it("maps a public URL to its object key, and refuses one from another origin", () => {
    expect(
      objectKeyOf("https://meta.kippu.rocks", "https://meta.kippu.rocks/v0/schemas/event/1.0.json"),
    ).toBe("v0/schemas/event/1.0.json");
    expect(() =>
      objectKeyOf("https://meta.kippu.rocks", "https://api.kippu.rocks/v0/x.json"),
    ).toThrow();
  });
});
