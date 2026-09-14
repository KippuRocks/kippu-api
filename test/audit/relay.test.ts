import { createProfileV0, PASS_SIGNING_TAG } from "@ticketto/profile-v0";
import { softwareP256Signer } from "@ticketto/profile-v0/testing";
import {
  type Command,
  createTicketto,
  type Signer,
  type Ticketto,
  type ZoneId,
} from "@ticketto/sdk";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  AuditError,
  type AuditLog,
  createAuditLog,
  type RelayRequest,
} from "../../src/audit/audit-log.js";
import { auditedSigner, commandOfSigningPayload, relay } from "../../src/audit/relay.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import {
  expectEveryRelayedWriteAudited,
  type ScriptedBackend,
  scriptedBackend,
  scriptedSponsor,
} from "../support/ledger.js";

const profile = createProfileV0({ rpId: "holder.kippu.example" });
const zone = (byte: number) => byte.toString(16).padStart(2, "0").repeat(32) as ZoneId;

const organiserRequest: RelayRequest = {
  requestId: "req-1",
  principal: {
    kind: "organiser",
    organiserId: "6f4f7c1e-2a57-4a4e-9d65-0f1c1b0e7a10",
    sessionId: "0b7c3a53-5d7e-4a0f-8f7b-3f0a8e2b9c41",
  },
};

it("reads the command back out of its signing payload, and nothing else", () => {
  const command: Command = {
    kind: "setEventStatus",
    operationId: "00112233445566778899aabbccddeeff" as Command["operationId"],
    expiresAt: 1_800_000_000_000,
    event: zone(7) as unknown as Extract<Command, { kind: "setEventStatus" }>["event"],
    status: "Sealed",
  };
  const payload = profile.encodeCommand(command);

  expect(commandOfSigningPayload(payload)).toEqual(command);
  expect(commandOfSigningPayload(payload.subarray(1))).toBeNull();
  expect(commandOfSigningPayload(new Uint8Array([...PASS_SIGNING_TAG, 1, 2, 3]))).toBeNull();
});

describeWithStore("relayed writes and the audit log", () => {
  let database: TestDatabase;
  let audit: AuditLog;
  let backend: ScriptedBackend;
  let ticketto: Ticketto;
  let signer: Signer;
  let signatures: number;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    audit = createAuditLog(database.store);
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(() => {
    backend = scriptedBackend();
    ticketto = createTicketto({
      backend,
      profile,
      sponsor: scriptedSponsor(),
      operationLifetime: 60_000,
    });
    const inner = softwareP256Signer().signer;
    signatures = 0;
    signer = {
      account: inner.account,
      sign: (payload) => {
        signatures += 1;
        return inner.sign(payload);
      },
    };
  });

  const options = (request: RelayRequest = organiserRequest) => ({
    audit,
    request,
    onAuditFailure: (error: unknown) => {
      throw error;
    },
  });

  it("NFR-7: every relayed write in the integration test has an audit row", async () => {
    backend.reject("setEventCapacity", "ERR-CapacityExceeded");

    const created = relay(options(), signer, (s) =>
      ticketto.createEvent(s, {
        salt: new Uint8Array(32).fill(1),
        zones: [{ id: zone(1), kind: "Unseated" }],
        capacity: 100,
        metadata: null,
      }),
    );
    const createdResult = await created.submission;
    expect(createdResult.ok).toBe(true);
    const event = created.id;

    // One after another, so the backend's submission order is known.
    const outcomes = [
      await relay(options({ ...organiserRequest, requestId: "req-2" }), signer, (s) =>
        ticketto.addZone(s, { event, zone: { id: zone(2), kind: "Seated" } }),
      ),
      await relay(options({ ...organiserRequest, requestId: "req-3" }), signer, (s) =>
        ticketto.setEventCapacity(s, { event, capacity: 1, proof: null }),
      ),
      await relay(options({ ...organiserRequest, requestId: "req-4" }), signer, (s) =>
        ticketto.setEventStatus(s, { event, status: "Sealed" }),
      ),
    ];

    expect(backend.submitted).toHaveLength(4);
    expect(signatures).toBe(4);
    await expectEveryRelayedWriteAudited(audit, backend.submitted);

    const [createdId, zoneId, capacityId, statusId] = backend.submitted as [
      Command["operationId"],
      Command["operationId"],
      Command["operationId"],
      Command["operationId"],
    ];
    expect(await audit.find(createdId)).toMatchObject({
      requestId: "req-1",
      principal: organiserRequest.principal,
      commandKind: "createEvent",
      outcome: "settled",
      receiptCursor: createdResult.ok ? createdResult.value.cursor : null,
    });
    expect(await audit.find(zoneId)).toMatchObject({
      requestId: "req-2",
      commandKind: "addZone",
      outcome: "settled",
    });
    expect(await audit.find(capacityId)).toMatchObject({
      requestId: "req-3",
      commandKind: "setEventCapacity",
      outcome: "rejected",
      errorCode: "ERR-CapacityExceeded",
      receiptCursor: null,
    });
    expect(await audit.find(statusId)).toMatchObject({ commandKind: "setEventStatus" });
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, false, true]);
  });

  it("NFR-7: records the row before the write is signed", async () => {
    let rowAtSigning: unknown = "not signed";
    const checking: Signer = {
      account: signer.account,
      async sign(payload) {
        const command = commandOfSigningPayload(payload);
        rowAtSigning = command === null ? null : await audit.find(command.operationId);
        return signer.sign(payload);
      },
    };

    await relay(options(), checking, (s) =>
      ticketto.setEventStatus(s, { event: zone(9) as never, status: "Sealed" }),
    );

    expect(rowAtSigning).toMatchObject({ outcome: "pending", commandKind: "setEventStatus" });
  });

  it("NFR-7: no signature, and no submission, when the row cannot be written", async () => {
    const refusing: AuditLog = {
      ...audit,
      record: () => Promise.reject(new AuditError("store unavailable")),
    };

    const submission = relay({ ...options(), audit: refusing }, signer, (s) =>
      ticketto.setEventStatus(s, { event: zone(9) as never, status: "Sealed" }),
    );

    await expect(submission).rejects.toThrow("store unavailable");
    expect(signatures).toBe(0);
    expect(backend.submitted).toEqual([]);
  });

  it("an audited signer refuses to sign what is not a command", async () => {
    const audited = auditedSigner(signer, audit, organiserRequest);

    await expect(audited.sign(new Uint8Array([...PASS_SIGNING_TAG, 0]))).rejects.toThrow(
      AuditError,
    );
    expect(signatures).toBe(0);
  });

  it("a write refused its sponsorship is recorded as rejected", async () => {
    const sponsor = scriptedSponsor(true);
    const unsponsored = createTicketto({ backend, profile, sponsor, operationLifetime: 60_000 });

    const result = await relay(options(), signer, (s) =>
      unsponsored.setEventStatus(s, { event: zone(9) as never, status: "Sealed" }),
    );

    expect(result).toEqual({ ok: false, error: { code: "ERR-SponsorshipRefused" } });
    expect(backend.submitted).toEqual([]);
    await expectEveryRelayedWriteAudited(audit, sponsor.seen);
    expect(await audit.find(sponsor.seen[0] as Command["operationId"])).toMatchObject({
      outcome: "rejected",
      errorCode: "ERR-SponsorshipRefused",
    });
  });

  it("a write that fails without a verdict is recorded as failed", async () => {
    backend.fail("setEventStatus", new Error("connection reset"));

    const submission = relay(options(), signer, (s) =>
      ticketto.setEventStatus(s, { event: zone(9) as never, status: "Sealed" }),
    );

    await expect(submission).rejects.toThrow("connection reset");
    expect(await audit.find(backend.submitted[0] as Command["operationId"])).toMatchObject({
      outcome: "failed",
      receiptCursor: null,
      errorCode: null,
    });
  });

  it("an operation is recorded once, and its outcome once", async () => {
    const entry = { ...organiserRequest, operationId: "ff".repeat(16), commandKind: "addZone" };
    await audit.record(entry as Parameters<AuditLog["record"]>[0]);

    await expect(audit.record(entry as Parameters<AuditLog["record"]>[0])).rejects.toThrow(
      AuditError,
    );
    await audit.complete(entry.operationId as never, { outcome: "failed" });
    await expect(audit.complete(entry.operationId as never, { outcome: "failed" })).rejects.toThrow(
      AuditError,
    );
  });
});
