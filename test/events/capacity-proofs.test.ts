import { randomBytes } from "node:crypto";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { encodeSignedAccessPass, encodeSignedCommand } from "@ticketto/profile-v0";
import type { Cursor, EventId, LogRecord, SignedCommand } from "@ticketto/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  checkArtefact,
  createS3ProofArtefactStorage,
  loadProofStorageConfig,
  MAX_PROOF_ARTEFACT_BYTES,
  PROOF_ARTEFACT_CACHE_CONTROL,
  sniffArtefactType,
} from "../../src/proofs/artefacts.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  refusal,
  refusalWithReason,
  type TestOrganiser,
} from "../support/events.js";
import {
  createTestBucket,
  describeWithObjectStorage,
  type TestBucket,
} from "../support/object-storage.js";

// Store-backed: generous timeouts, so a loaded CI host or database does not fail the suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** A PDF carrying a marker of its own, so its bytes can be searched for. */
function certificate(): { data: string; marker: string; bytes: Buffer } {
  const marker = `Venue certificate ${randomBytes(12).toString("hex")}`;
  const bytes = Buffer.from(`%PDF-1.7\n% ${marker}\n%%EOF\n`);
  return { data: bytes.toString("base64"), marker, bytes };
}

describe("capacity proof artefacts", () => {
  it("REQ-EV-6: recognises PDF, JPEG and PNG by their signatures, and nothing else", () => {
    expect(sniffArtefactType(Buffer.from("%PDF-1.4"))).toBe("application/pdf");
    expect(sniffArtefactType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffArtefactType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    );
    expect(sniffArtefactType(Buffer.from("<svg/>"))).toBeNull();
  });

  it("REQ-EV-6: refuses another type, bytes not of the type declared, and an artefact too large", () => {
    const pdf = Buffer.from("%PDF-1.4").toString("base64");
    expect(checkArtefact("image/svg+xml", pdf)).toMatchObject({ ok: false });
    expect(checkArtefact("image/png", pdf)).toMatchObject({ ok: false });
    expect(checkArtefact("application/pdf", "not base64!")).toMatchObject({ ok: false });
    const large = Buffer.alloc(MAX_PROOF_ARTEFACT_BYTES + 1);
    large.write("%PDF-");
    expect(checkArtefact("application/pdf", large.toString("base64"))).toMatchObject({
      ok: false,
    });
    expect(checkArtefact("application/pdf", pdf)).toMatchObject({
      ok: true,
      mediaType: "application/pdf",
    });
  });

  it("NFR-6: the proof bucket is never the metadata bucket, which the edge serves publicly", () => {
    const env = { KIPPU_METADATA_S3_BUCKET: "kippu-metadata" };
    expect(() => loadProofStorageConfig(env)).toThrow(/KIPPU_PROOFS_S3_BUCKET is required/);
    expect(() =>
      loadProofStorageConfig({ ...env, KIPPU_PROOFS_S3_BUCKET: "kippu-metadata" }),
    ).toThrow(/must not be the metadata bucket/);
    expect(
      loadProofStorageConfig({ ...env, KIPPU_PROOFS_S3_BUCKET: "kippu-proofs" }),
    ).toMatchObject({ bucket: "kippu-proofs" });
    expect(PROOF_ARTEFACT_CACHE_CONTROL).toBe("private, no-store");
  });
});

describeWithObjectStorage("capacity proof storage over S3", () => {
  let bucket: TestBucket;

  beforeAll(async () => {
    bucket = await createTestBucket();
  });

  afterAll(async () => {
    await bucket.drop();
  });

  it("NFR-6: keeps an artefact's bytes and type, stored never to be cached", async () => {
    const storage = createS3ProofArtefactStorage(bucket.config);
    const artefact = certificate();
    await storage.put("capacity-proofs/one", artefact.bytes, { contentType: "application/pdf" });

    expect(await storage.get("capacity-proofs/one")).toEqual({
      contentType: "application/pdf",
      bytes: new Uint8Array(artefact.bytes),
    });
    expect(await storage.get("capacity-proofs/none")).toBeNull();

    const client = new S3Client({
      region: bucket.config.region,
      forcePathStyle: true,
      ...(bucket.config.endpoint === undefined ? {} : { endpoint: bucket.config.endpoint }),
      ...(bucket.config.credentials === undefined
        ? {}
        : { credentials: bucket.config.credentials }),
    });
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket.config.bucket, Key: "capacity-proofs/one" }),
    );
    client.destroy();
    expect(head.CacheControl).toBe(PROOF_ARTEFACT_CACHE_CONTROL);
  });
});

describeWithStore("capacity proofs", () => {
  let harness: EventsHarness;

  beforeAll(async () => {
    harness = await eventsHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  async function setup(capacity: number | null) {
    const organiser = await harness.organiser();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: randomId(), kind: "Unseated" }],
      capacity,
      saleAsset: "COPM/2",
    });
    return { organiser, event };
  }

  const onLedger = async (event: string) => {
    const found = await harness.ledger.getEvent(event as EventId);
    if (!found.ok) throw new Error(found.error.code);
    return found.value;
  };

  async function logRecords(): Promise<LogRecord[]> {
    const records: LogRecord[] = [];
    let cursor = "" as Cursor;
    for (;;) {
      const page = await harness.ledger.log.read(cursor, 100);
      if (!page.ok) throw new Error(page.error.code);
      records.push(...page.value.records);
      if (page.value.records.length === 0 || page.value.next === cursor) break;
      cursor = page.value.next;
    }
    return records;
  }

  const capacityCommands = async (event: string) =>
    (await logRecords()).flatMap((record) => {
      if (!("command" in record.entry)) return [];
      const { command } = record.entry as SignedCommand;
      return command.kind === "setEventCapacity" && command.event === event ? [command] : [];
    });

  const ask = (organiser: TestOrganiser, event: string, capacity: number | null, data?: string) =>
    organiser.client.events.capacityProofs.request.mutate({
      event,
      capacity,
      artefact: { mediaType: "application/pdf", data: data ?? certificate().data },
    });

  it("AC-A6.3: an increase requested with an artefact waits for review and never reaches the ledger", async () => {
    const { organiser, event } = await setup(10);

    const requested = await ask(organiser, event, 20);
    expect(requested).toMatchObject({
      event,
      capacity: 20,
      status: "pending",
      decidedAt: null,
      proofId: null,
      cursor: null,
      artefact: { mediaType: "application/pdf" },
    });
    // Without approval, the direct route is still refused before the ledger.
    expect(
      await refusal(() => organiser.client.events.decreaseCapacity.mutate({ event, capacity: 20 })),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-CapacityProofRequired" });

    expect(await onLedger(event)).toMatchObject({ maxCapacity: 10 });
    expect(await capacityCommands(event)).toEqual([]);
    expect(await organiser.client.events.capacityProofs.list.query({ event })).toEqual([requested]);
  });

  it("AC-A6.4: an approved increase succeeds, and the ledger records the proof id that authorised it", async () => {
    const { organiser, event } = await setup(10);
    const reviewer = await harness.reviewer();
    const requested = await ask(organiser, event, 25);

    const queue = await reviewer.client.reviewers.capacityProofs.queue.query();
    expect(queue).toContainEqual({
      ...requested,
      organiserId: organiser.organiserId,
      reviewerId: null,
    });

    const approved = await reviewer.client.reviewers.capacityProofs.approve.mutate({
      request: requested.id,
    });
    expect(approved).toMatchObject({
      id: requested.id,
      status: "approved",
      reviewerId: reviewer.reviewerId,
      decidedAt: expect.any(Number),
      proofId: expect.stringMatching(/^[0-9a-f]{32}$/),
      cursor: expect.any(String),
    });
    expect(await onLedger(event)).toMatchObject({ maxCapacity: 25 });
    expect(await capacityCommands(event)).toEqual([
      expect.objectContaining({ capacity: 25, proof: approved.proofId }),
    ]);
    expect(await reviewer.client.reviewers.capacityProofs.queue.query()).not.toContainEqual(
      expect.objectContaining({ id: requested.id }),
    );

    // Audited as the reviewer's request, signed with the organiser's authority (NFR-7).
    const audit = await harness.database.store.query<{
      principal_kind: string;
      reviewer_id: string;
      session_id: string;
      outcome: string;
    }>(
      `SELECT principal_kind, reviewer_id, session_id, outcome FROM audit_log
       WHERE command_kind = 'setEventCapacity' AND reviewer_id = $1`,
      [reviewer.reviewerId],
    );
    expect(audit.rows).toEqual([
      {
        principal_kind: "reviewer",
        reviewer_id: reviewer.reviewerId,
        session_id: reviewer.sessionId,
        outcome: "settled",
      },
    ]);
  });

  it("REQ-EV-7: removing the bound is an increase, and succeeds once approved", async () => {
    const { organiser, event } = await setup(10);
    const reviewer = await harness.reviewer();
    const requested = await ask(organiser, event, null);
    await reviewer.client.reviewers.capacityProofs.approve.mutate({ request: requested.id });
    expect(await onLedger(event)).toMatchObject({ maxCapacity: null });
  });

  it("REQ-EV-6: a rejection records the reviewer and the time, and nothing reaches the ledger", async () => {
    const { organiser, event } = await setup(10);
    const reviewer = await harness.reviewer();
    const requested = await ask(organiser, event, 30);

    const rejected = await reviewer.client.reviewers.capacityProofs.reject.mutate({
      request: requested.id,
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      reviewerId: reviewer.reviewerId,
      decidedAt: expect.any(Number),
      proofId: null,
    });
    expect(await capacityCommands(event)).toEqual([]);
    expect(await onLedger(event)).toMatchObject({ maxCapacity: 10 });

    // A decision is final.
    for (const decide of [
      () => reviewer.client.reviewers.capacityProofs.approve.mutate({ request: requested.id }),
      () => reviewer.client.reviewers.capacityProofs.reject.mutate({ request: requested.id }),
    ]) {
      expect(await refusalWithReason(decide)).toEqual({
        code: "CONFLICT",
        errorCode: null,
        reason: "decided",
      });
    }
    // The organiser sees the outcome, and may ask again.
    expect(await organiser.client.events.capacityProofs.list.query({ event })).toEqual([
      expect.objectContaining({ id: requested.id, status: "rejected" }),
    ]);
    await ask(organiser, event, 15);
  });

  it("REQ-EV-6: the reviewer reads the artefact Kippu retains", async () => {
    const { organiser, event } = await setup(10);
    const reviewer = await harness.reviewer();
    const artefact = certificate();
    const requested = await ask(organiser, event, 12, artefact.data);

    expect(
      await reviewer.client.reviewers.capacityProofs.artefact.query({ request: requested.id }),
    ).toEqual({ mediaType: "application/pdf", data: artefact.data });
    expect(requested.artefact.size).toBe(artefact.bytes.length);
  });

  it("REQ-EV-5: a request that is not an increase, a second pending request, and a bad artefact are refused", async () => {
    const { organiser, event } = await setup(10);

    for (const capacity of [10, 4]) {
      expect(await refusalWithReason(() => ask(organiser, event, capacity))).toEqual({
        code: "BAD_REQUEST",
        errorCode: null,
        reason: "not-an-increase",
      });
    }
    // Bounding an event with none is a decrease; leaving it unbounded is no change.
    const unbounded = await setup(null);
    expect(await refusalWithReason(() => ask(unbounded.organiser, unbounded.event, 100))).toEqual({
      code: "BAD_REQUEST",
      errorCode: null,
      reason: "not-an-increase",
    });
    expect(await refusalWithReason(() => ask(unbounded.organiser, unbounded.event, null))).toEqual({
      code: "BAD_REQUEST",
      errorCode: null,
      reason: "not-an-increase",
    });

    await ask(organiser, event, 20);
    expect(await refusalWithReason(() => ask(organiser, event, 30))).toEqual({
      code: "CONFLICT",
      errorCode: null,
      reason: "pending",
    });

    const other = await setup(10);
    expect(
      await refusalWithReason(() =>
        other.organiser.client.events.capacityProofs.request.mutate({
          event: other.event,
          capacity: 20,
          artefact: { mediaType: "image/png", data: certificate().data },
        }),
      ),
    ).toEqual({ code: "BAD_REQUEST", errorCode: null, reason: "artefact" });
    expect(
      await other.organiser.client.events.capacityProofs.list.query({ event: other.event }),
    ).toEqual([]);
  });

  it("an organiser acts on their own events only, and never reaches the review queue", async () => {
    const { organiser, event } = await setup(10);
    const stranger = await harness.organiser();
    const requested = await ask(organiser, event, 20);

    expect(await refusal(() => ask(stranger, event, 20))).toEqual({
      code: "FORBIDDEN",
      errorCode: "ERR-NotOwner",
    });
    expect(
      await refusal(() => stranger.client.events.capacityProofs.list.query({ event })),
    ).toEqual({ code: "FORBIDDEN", errorCode: "ERR-NotOwner" });

    for (const reach of [
      () => organiser.client.reviewers.capacityProofs.queue.query(),
      () => organiser.client.reviewers.capacityProofs.artefact.query({ request: requested.id }),
      () => organiser.client.reviewers.capacityProofs.approve.mutate({ request: requested.id }),
      () => organiser.client.reviewers.capacityProofs.reject.mutate({ request: requested.id }),
    ]) {
      expect(await refusal(reach)).toEqual({ code: "FORBIDDEN", errorCode: null });
    }
    // A reviewer is not an organiser either.
    const reviewer = await harness.reviewer();
    expect(
      await refusal(() => reviewer.client.events.capacityProofs.list.query({ event })),
    ).toEqual({ code: "FORBIDDEN", errorCode: null });
    expect(await onLedger(event)).toMatchObject({ maxCapacity: 10 });
  });

  it("an approval the ledger refuses is passed on, and leaves the request pending", async () => {
    const { organiser, event } = await setup(10);
    const reviewer = await harness.reviewer();
    const requested = await ask(organiser, event, 20);
    await organiser.client.events.seal.mutate({ event });

    expect(
      await refusal(() =>
        reviewer.client.reviewers.capacityProofs.approve.mutate({ request: requested.id }),
      ),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-EventSealed" });
    expect(await organiser.client.events.capacityProofs.list.query({ event })).toEqual([
      expect.objectContaining({ status: "pending", proofId: null }),
    ]);
    await reviewer.client.reviewers.capacityProofs.reject.mutate({ request: requested.id });
  });

  it("an unknown request is not found", async () => {
    const reviewer = await harness.reviewer();
    expect(
      await refusal(() =>
        reviewer.client.reviewers.capacityProofs.approve.mutate({
          request: "00000000-0000-4000-8000-000000000000",
        }),
      ),
    ).toEqual({ code: "NOT_FOUND", errorCode: null });
  });

  it("NFR-6: no artefact byte reaches the ledger: only the proof id does", async () => {
    const { organiser, event } = await setup(10);
    const reviewer = await harness.reviewer();
    const artefact = certificate();
    const requested = await ask(organiser, event, 40, artefact.data);
    const approved = await reviewer.client.reviewers.capacityProofs.approve.mutate({
      request: requested.id,
    });

    const encoded = (await logRecords()).map((record) =>
      "command" in record.entry
        ? encodeSignedCommand(record.entry)
        : encodeSignedAccessPass(record.entry),
    );
    expect(encoded.length).toBeGreaterThan(0);
    const needles: [string, Buffer][] = [
      ["the artefact's marker", Buffer.from(artefact.marker)],
      ["the artefact's bytes", artefact.bytes],
      ["the PDF signature", Buffer.from("%PDF-")],
      ["the request id", Buffer.from(requested.id)],
    ];
    for (const bytes of encoded) {
      for (const [name, needle] of needles) {
        expect([name, Buffer.from(bytes).includes(needle)]).toEqual([name, false]);
      }
    }
    // The artefact is kept in Kippu's private storage, under the request.
    expect(harness.proofStorage.keys()).toContain(`capacity-proofs/${requested.id}`);
    expect(approved.proofId).not.toBeNull();
  });
});
