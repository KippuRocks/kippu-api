import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMetadataEdge } from "../../src/metadata/edge.js";
import { checkImage, MAX_IMAGE_BYTES, sniffImageType } from "../../src/metadata/images.js";
import type { ImageMediaType } from "../../src/metadata/ports.js";
import { checkStoredDocuments } from "../../src/metadata/self-contained.js";
import { createS3MetadataStorage, type MetadataStorage } from "../../src/metadata/storage.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  refusal,
  type TestOrganiser,
} from "../support/events.js";
import {
  createTestBucket,
  describeWithObjectStorage,
  type TestBucket,
} from "../support/object-storage.js";

const ORIGIN = "https://meta.kippu.rocks";
const CLIENT_ORIGIN = "https://any-ticketto-client.example";

/** A genuine 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
/** Bytes that open as a JPEG, padded to `size`. */
const jpeg = (size: number) => {
  const bytes = Buffer.alloc(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
};
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x1a, 0, 0, 0]),
  Buffer.from("WEBPVP8 "),
  Buffer.alloc(14),
]);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://api.kippu.rocks/x"/></svg>',
);

describe("image checks", () => {
  it("recognises JPEG, PNG and WebP by their signatures, and nothing else", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(jpeg(16))).toBe("image/jpeg");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(SVG)).toBeNull();
    expect(sniffImageType(Buffer.from("GIF89a"))).toBeNull();
  });

  it.each([
    ["an SVG", "image/svg+xml", SVG.toString("base64")],
    ["a GIF", "image/gif", Buffer.from("GIF89a....").toString("base64")],
    ["bytes of another type than declared", "image/jpeg", PNG.toString("base64")],
    [
      "an image one byte over the limit",
      "image/jpeg",
      jpeg(MAX_IMAGE_BYTES + 1).toString("base64"),
    ],
    ["data that is not base64", "image/png", "not base64!"],
    ["an empty image", "image/png", ""],
  ])("refuses %s", (_, mediaType, data) => {
    expect(checkImage(mediaType, data)).toMatchObject({ ok: false });
  });

  it("accepts an image exactly at the limit", () => {
    expect(checkImage("image/jpeg", jpeg(MAX_IMAGE_BYTES).toString("base64"))).toMatchObject({
      ok: true,
    });
  });
});

describeWithStore("image upload for event documents", () => {
  describeWithObjectStorage("into S3-compatible metadata storage", () => {
    let bucket: TestBucket;
    let storage: MetadataStorage;
    let harness: EventsHarness;
    let edge: FastifyInstance;
    let edgeUrl: string;

    beforeAll(async () => {
      bucket = await createTestBucket();
      storage = createS3MetadataStorage(bucket.config);
      harness = await eventsHarness({ metadataStorage: storage });
      edge = buildMetadataEdge({ storage });
      await edge.listen({ host: "127.0.0.1", port: 0 });
      edgeUrl = `http://127.0.0.1:${(edge.server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await edge?.close();
      await harness?.close();
      await bucket?.drop();
    });

    /** Where the local CDN stand-in serves what a URL at the metadata origin names. */
    const served = (url: string) => `${edgeUrl}${new URL(url).pathname}`;

    async function eventOf(organiser: TestOrganiser): Promise<string> {
      const { event } = await organiser.client.events.create.mutate({
        zones: [{ id: randomId(), kind: "Unseated" }],
        capacity: null,
      });
      return event;
    }

    it("REQ-MD-4: an uploaded image is served cross-origin at the metadata origin, and a document referencing it passes the self-containment check", async () => {
      const organiser = await harness.organiser();
      const event = await eventOf(organiser);

      const image = await organiser.client.metadata.images.upload.mutate({
        event,
        mediaType: "image/png",
        data: PNG.toString("base64"),
      });

      const digest = createHash("sha256").update(PNG).digest("hex");
      expect(image).toEqual({
        url: `${ORIGIN}/v0/images/${event}/${digest}.png`,
        mediaType: "image/png",
        size: PNG.length,
      });

      // Fetched as a page on another origin fetches it: no credentials of any kind.
      const response = await fetch(served(image.url), {
        credentials: "omit",
        headers: { origin: CLIENT_ORIGIN },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);

      // A document referencing it is accepted, stored, and self-contained (REQ-MD-1).
      const document = {
        ...JSON.parse(
          await readFile(
            new URL("../../packages/metadata-schema/test/fixtures/event.json", import.meta.url),
            "utf8",
          ),
        ),
        eventId: event,
        imagery: [{ url: image.url, alt: "The stage", mediaType: image.mediaType }],
        seatMaps: [],
      };
      await organiser.client.metadata.events.put.mutate({ event, document });
      expect(await checkStoredDocuments(storage, ORIGIN)).toEqual([]);
    });

    it("answers the same URL for the same bytes, and a new one for new bytes", async () => {
      const organiser = await harness.organiser();
      const event = await eventOf(organiser);
      const upload = (data: Buffer) =>
        organiser.client.metadata.images.upload.mutate({
          event,
          mediaType: "image/jpeg",
          data: data.toString("base64"),
        });
      const bytes = jpeg(1024);
      const first = await upload(bytes);
      expect((await upload(bytes)).url).toBe(first.url);
      const other = Buffer.concat([bytes, randomBytes(8)]);
      expect((await upload(other)).url).not.toBe(first.url);
      expect(first.url).toMatch(/\.jpg$/);
    });

    it("takes an image at the size limit over HTTP, and refuses one over it", async () => {
      const organiser = await harness.organiser();
      const event = await eventOf(organiser);
      await expect(
        organiser.client.metadata.images.upload.mutate({
          event,
          mediaType: "image/jpeg",
          data: jpeg(MAX_IMAGE_BYTES).toString("base64"),
        }),
      ).resolves.toMatchObject({ size: MAX_IMAGE_BYTES });
      expect(
        await refusal(() =>
          organiser.client.metadata.images.upload.mutate({
            event,
            mediaType: "image/jpeg",
            data: jpeg(MAX_IMAGE_BYTES + 1).toString("base64"),
          }),
        ),
      ).toEqual({ code: "BAD_REQUEST", errorCode: null });
    });

    it("refuses other types, mislabelled bytes, and another organiser's event, storing nothing", async () => {
      const owner = await harness.organiser();
      const other = await harness.organiser();
      const event = await eventOf(owner);
      const cases = [
        // Types a client compiled against @kippurocks/api cannot name, sent anyway.
        { mediaType: "image/svg+xml" as ImageMediaType, data: SVG.toString("base64") },
        {
          mediaType: "image/gif" as ImageMediaType,
          data: Buffer.from("GIF89a").toString("base64"),
        },
        { mediaType: "image/jpeg" as const, data: PNG.toString("base64") },
      ];
      for (const input of cases) {
        expect(
          await refusal(() => owner.client.metadata.images.upload.mutate({ event, ...input })),
        ).toEqual({ code: "BAD_REQUEST", errorCode: null });
      }
      expect(
        await refusal(() =>
          other.client.metadata.images.upload.mutate({
            event,
            mediaType: "image/png",
            data: PNG.toString("base64"),
          }),
        ),
      ).toEqual({ code: "FORBIDDEN", errorCode: "ERR-NotOwner" });

      const stored: string[] = [];
      for await (const key of storage.list(`v0/images/${event}/`)) stored.push(key);
      expect(stored).toEqual([]);
    });
  });
});
