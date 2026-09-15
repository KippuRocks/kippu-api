import { readFile } from "node:fs/promises";
import { classLocator, eventLocator } from "@kippurocks/metadata-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "../../src/metadata/ports.js";
import { checkStoredDocuments, foreignReferences } from "../../src/metadata/self-contained.js";
import { createS3MetadataStorage, type MetadataStorage } from "../../src/metadata/storage.js";
import { describeWithStore } from "../support/database.js";
import { type EventsHarness, eventsHarness, randomId, refusal } from "../support/events.js";
import {
  createTestBucket,
  describeWithObjectStorage,
  memoryMetadataStorage,
  type TestBucket,
} from "../support/object-storage.js";

const ORIGIN = "https://meta.kippu.rocks";

/** URLs of Kippu's APIs, as a document might be tempted to reference them. */
const KIPPU_API_URLS = [
  "https://api.kippu.rocks/v0/trpc/events.get?input=%7B%7D",
  "http://localhost:8080/v0/trpc/metadata.events.put",
  "https://kippu.rocks/v0/images/poster.jpg",
];

async function fixture(name: string): Promise<Record<string, JsonValue>> {
  return JSON.parse(
    await readFile(
      new URL(`../../packages/metadata-schema/test/fixtures/${name}`, import.meta.url),
      "utf8",
    ),
  );
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("foreign references", () => {
  it("REQ-MD-1: finds every URL not served from the metadata origin, with where it is", async () => {
    const document = {
      ...(await fixture("event.json")),
      imagery: [{ url: `${ORIGIN}/v0/images/poster.jpg` }, { url: KIPPU_API_URLS[0] as string }],
      seatMaps: [{ url: KIPPU_API_URLS[1] as string }],
    };
    expect(foreignReferences(document, ORIGIN)).toEqual([
      { pointer: "/imagery/1/url", url: KIPPU_API_URLS[0] },
      { pointer: "/seatMaps/0/url", url: KIPPU_API_URLS[1] },
    ]);
  });

  it("accepts a document whose every URL — its $schema, images and seat maps — is the same storage's", async () => {
    expect(foreignReferences(await fixture("event.json"), ORIGIN)).toEqual([]);
    expect(foreignReferences(await fixture("class.json"), ORIGIN)).toEqual([]);
  });

  it("does not follow web addresses mentioned in prose", () => {
    expect(
      foreignReferences({ description: `Tickets also at ${KIPPU_API_URLS[0]} today` }, ORIGIN),
    ).toEqual([]);
  });

  it("treats another host under the same domain as foreign", () => {
    expect(foreignReferences({ url: KIPPU_API_URLS[2] as string }, ORIGIN)).toHaveLength(1);
  });
});

describeWithStore("self-contained documents through the editing routers", () => {
  let harness: EventsHarness;
  let storage: MetadataStorage;

  beforeAll(async () => {
    storage = memoryMetadataStorage();
    harness = await eventsHarness({ metadataStorage: storage });
  });

  afterAll(async () => {
    await harness.close();
  });

  it("REQ-MD-1: no stored document references a Kippu API URL", async () => {
    const organiser = await harness.organiser();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: randomId(), kind: "Unseated" }],
      capacity: null,
    });
    const guests = await organiser.client.events.classes.define.mutate({
      event,
      name: "Guest list",
      description: null,
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: false, cannotTransfer: false },
      quota: null,
    });
    const valid = { ...(await fixture("event.json")), eventId: event };

    // Every way a document could carry a Kippu API URL is refused, and nothing is stored.
    for (const url of KIPPU_API_URLS) {
      for (const document of [
        { ...valid, imagery: [{ url }] },
        { ...valid, seatMaps: [{ url }] },
      ]) {
        expect(
          await refusal(() => organiser.client.metadata.events.put.mutate({ event, document })),
        ).toEqual({ code: "BAD_REQUEST", errorCode: null });
      }
    }
    expect(await storage.head(new URL(eventLocator(event)).pathname.slice(1))).toBeNull();

    // Self-contained documents are stored, and the check over storage finds nothing.
    await organiser.client.metadata.events.put.mutate({ event, document: valid });
    await organiser.client.metadata.classes.put.mutate({
      event,
      class: guests.id,
      document: { ...(await fixture("class.json")), classId: guests.id, eventId: event },
    });
    expect(await checkStoredDocuments(storage, ORIGIN)).toEqual([]);

    // The check does find one that reached storage by any other path.
    const planted = new URL(classLocator(randomId())).pathname.slice(1);
    await storage.put(planted, encode({ imagery: [{ url: KIPPU_API_URLS[0] }] }), {
      contentType: "application/json",
    });
    expect(await checkStoredDocuments(storage, ORIGIN)).toEqual([
      { key: planted, references: [{ pointer: "/imagery/0/url", url: KIPPU_API_URLS[0] }] },
    ]);
  });
});

describeWithObjectStorage("the self-containment check over S3-compatible storage", () => {
  let bucket: TestBucket;
  let storage: MetadataStorage;

  beforeAll(async () => {
    bucket = await createTestBucket();
    storage = createS3MetadataStorage(bucket.config);
  });

  afterAll(async () => {
    await bucket.drop();
  });

  it("REQ-MD-1: lists every stored event and class document, and reports only the foreign ones", async () => {
    const clean = new URL(eventLocator(randomId())).pathname.slice(1);
    const foreign = new URL(eventLocator(randomId())).pathname.slice(1);
    const broken = new URL(classLocator(randomId())).pathname.slice(1);
    const schema = "v0/schemas/event/1.0.json";
    await storage.put(clean, encode(await fixture("event.json")), {
      contentType: "application/json",
    });
    await storage.put(foreign, encode({ seatMaps: [{ url: KIPPU_API_URLS[1] }] }), {
      contentType: "application/json",
    });
    await storage.put(broken, new TextEncoder().encode("not json"), {
      contentType: "application/json",
    });
    // Outside the document prefixes: not a document.
    await storage.put(schema, encode({ $id: KIPPU_API_URLS[0] }), {
      contentType: "application/schema+json",
    });

    const listed: string[] = [];
    for await (const key of storage.list("v0/")) listed.push(key);
    expect(listed).toEqual([clean, foreign, broken, schema].sort());

    const violations = await checkStoredDocuments(storage, ORIGIN);
    expect(violations).toHaveLength(2);
    expect(violations).toContainEqual({
      key: foreign,
      references: [{ pointer: "/seatMaps/0/url", url: KIPPU_API_URLS[1] }],
    });
    expect(violations).toContainEqual(
      expect.objectContaining({ key: broken, references: [], unreadable: expect.any(String) }),
    );
  });
});
