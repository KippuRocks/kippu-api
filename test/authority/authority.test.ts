import type { KmsP256Key } from "@kippu/sponsorship";
import { createProfileV0, registrationAccount } from "@ticketto/profile-v0";
import {
  type Command,
  createSubmission,
  type OperationId,
  type Registration,
  type Sponsor,
  type Sponsorship,
  type ZoneId,
} from "@ticketto/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditError, type AuditLog, createAuditLog } from "../../src/audit/audit-log.js";
import {
  createOrganiserAuthority,
  type OrganiserAuthority,
  organiserSigner,
} from "../../src/authority/authority.js";
import { SpecCodeError } from "../../src/authority/errors.js";
import {
  type OrganiserKms,
  organiserKmsFor,
  softwareOrganiserKms,
} from "../../src/authority/kms.js";
import { type KippuTicketto, makeTicketto } from "../../src/ledger/ticketto.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { expectEveryRelayedWriteAudited } from "../support/ledger.js";
import { createOrganiser } from "../support/organisers.js";

const HOLDER_RP_ID = "holder.kippu.example";
const profile = createProfileV0({ rpId: HOLDER_RP_ID });
const sponsor: Sponsor = {
  sponsor: async () => ({ ok: true, value: new Uint8Array() as Sponsorship }),
};
const zone = "a1".repeat(32) as ZoneId;

/** What the KMS had been asked, and what the store held, when each signature was made. */
interface KmsCall {
  readonly pendingOperations: readonly string[];
  readonly accountRows: number;
}

describe("organiserKmsFor", () => {
  it("uses the software stand-in in development and tests", () => {
    expect(() => organiserKmsFor("development")).not.toThrow();
    expect(() => organiserKmsFor("test")).not.toThrow();
  });

  it("refuses production until a KMS provider is chosen", () => {
    expect(() => organiserKmsFor("production")).toThrow(/no KMS provider/);
  });
});

describeWithStore("organiser authority", () => {
  let database: TestDatabase;
  let audit: AuditLog;
  let ticketto: KippuTicketto;
  let kms: OrganiserKms & { readonly created: string[]; readonly calls: KmsCall[] };
  let authority: OrganiserAuthority;

  /** The software KMS, recording every key created and what the store held at every signature. */
  function observedKms(): typeof kms {
    const inner = softwareOrganiserKms();
    const created: string[] = [];
    const calls: KmsCall[] = [];
    const observed = (key: KmsP256Key): KmsP256Key => ({
      publicKey: key.publicKey,
      async signDigest(digest) {
        const pending = await database.store.query<{ operation_id: string }>(
          "SELECT operation_id FROM audit_log WHERE outcome = 'pending'",
        );
        const accounts = await database.store.query(
          "SELECT 1 FROM organiser_ledger_accounts WHERE public_key = $1",
          [Buffer.from(key.publicKey)],
        );
        calls.push({
          pendingOperations: pending.rows.map((row) => row.operation_id),
          accountRows: accounts.rowCount ?? 0,
        });
        return key.signDigest(digest);
      },
    });
    return {
      created,
      calls,
      async createKey(organiserId) {
        const made = await inner.createKey(organiserId);
        created.push(organiserId);
        return { keyRef: made.keyRef, key: observed(made.key) };
      },
      async key(keyRef) {
        return observed(await inner.key(keyRef));
      },
    };
  }

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    audit = createAuditLog(database.store);
    ticketto = makeTicketto({
      environment: "test",
      holderRpId: HOLDER_RP_ID,
      sponsor,
      operationLifetime: 60_000,
    });
    kms = observedKms();
    authority = createOrganiserAuthority({
      store: database.store,
      kms,
      audit,
      ledger: ticketto,
      onAuditFailure: (error) => {
        throw error;
      },
    });
  });

  afterAll(async () => {
    await database.drop();
  });

  const operationsOf = async (requestId: string): Promise<OperationId[]> =>
    (
      await database.store.query<{ operation_id: OperationId }>(
        "SELECT operation_id FROM audit_log WHERE request_id = $1 ORDER BY id",
        [requestId],
      )
    ).rows.map((row) => row.operation_id);

  it("AC-A2.1: each organiser's authority is a Kippu-held p256 key of their own, registered on the ledger", async () => {
    const first = await createOrganiser(database.store);
    const second = await createOrganiser(database.store);

    const firstAccount = await authority.provision(first.organiserId, first.request);
    const secondAccount = await authority.provision(second.organiserId, second.request);

    expect(firstAccount).not.toBe(secondAccount);
    for (const [{ organiserId }, account] of [
      [first, firstAccount],
      [second, secondAccount],
    ] as const) {
      const row = (
        await database.store.query<{ public_key: Buffer; registration: Buffer }>(
          "SELECT public_key, registration FROM organiser_ledger_accounts WHERE organiser_id = $1",
          [organiserId],
        )
      ).rows[0];
      expect(row).toBeDefined();
      const registration = Uint8Array.from(row?.registration as Buffer) as Registration;
      const named = registrationAccount(registration);
      expect(named.ok && named.value.account).toBe(account);
      // The ledger holds the key's registration: the account can sign commands (REQ-CP-6).
      const onLedger = await ticketto.getCredential(
        account,
        (named.ok ? named.value.credential : "") as never,
      );
      expect(onLedger).toEqual({ ok: true, value: registration });
      expect(await authority.account(organiserId)).toBe(account);
    }

    // Provisioning again reuses the key: one key per organiser.
    expect(await authority.provision(first.organiserId, first.request)).toBe(firstAccount);
    expect(kms.created.filter((id) => id === first.organiserId)).toHaveLength(1);

    // Kippu exercises the authority: an event created through it is the organiser's on the ledger.
    const created = await authority.relay(first.organiserId, first.request, (signer) =>
      ticketto.createEvent(signer, {
        salt: new Uint8Array(32).fill(1),
        zones: [{ id: zone, kind: "Unseated" }],
        capacity: null,
        metadata: null,
      }),
    );
    expect((await created.submission).ok).toBe(true);
    expect(await ticketto.getEvent(created.id)).toMatchObject({
      ok: true,
      value: { owner: firstAccount, status: "Active" },
    });
  });

  it("keeps only the key's reference and public facts in the Kippu store", async () => {
    const columns = await database.store.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'organiser_ledger_accounts' ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "account",
      "created_at",
      "kms_key_ref",
      "organiser_id",
      "provisioned_principal_kind",
      "provisioned_request_id",
      "provisioned_session_id",
      "public_key",
      "registered_at",
      "registration",
      "registration_signed_at",
    ]);
  });

  it("NFR-7: a signature by an organiser's key exists only with a prior audit row", async () => {
    const { organiserId, request } = await createOrganiser(database.store);
    const before = kms.calls.length;

    const created = await authority.relay(organiserId, request, (signer) =>
      ticketto.createEvent(signer, {
        salt: new Uint8Array(32).fill(2),
        zones: [{ id: zone, kind: "Seated" }],
        capacity: 10,
        metadata: null,
      }),
    );
    expect((await created.submission).ok).toBe(true);
    const added = await authority.relay(organiserId, request, (signer) =>
      ticketto.addZone(signer, {
        event: created.id,
        zone: { id: "b2".repeat(32) as ZoneId, kind: "Unseated" },
      }),
    );
    expect((await added).ok).toBe(true);

    const operations = await operationsOf(request.requestId);
    // registerCredential, createEvent, addZone.
    expect(operations).toHaveLength(3);
    await expectEveryRelayedWriteAudited(audit, operations);

    const calls = kms.calls.slice(before);
    // The self-registration, then one signature per command.
    expect(calls).toHaveLength(1 + operations.length);
    expect(calls[0]?.accountRows).toBe(1);
    calls.slice(1).forEach((call, index) => {
      expect(call.pendingOperations).toContain(operations[index]);
    });
  });

  it("NFR-7: the KMS is never called for a command without a pending audit row", async () => {
    const { organiserId, request } = await createOrganiser(database.store);
    await authority.provision(organiserId, request);
    const row = (
      await database.store.query<{ kms_key_ref: string }>(
        "SELECT kms_key_ref FROM organiser_ledger_accounts WHERE organiser_id = $1",
        [organiserId],
      )
    ).rows[0];
    const signer = organiserSigner(await kms.key(row?.kms_key_ref as string), audit);
    const before = kms.calls.length;

    const command: Command = {
      kind: "setEventStatus",
      operationId: "0f".repeat(16) as OperationId,
      expiresAt: Date.now() + 60_000,
      event: "c3".repeat(32) as never,
      status: "Sealed",
    };
    await expect(signer.sign(profile.encodeCommand(command))).rejects.toThrow(AuditError);
    await expect(signer.sign(new Uint8Array([1, 2, 3]))).rejects.toThrow(AuditError);

    // A row that is no longer pending authorises nothing either: its write already ended.
    await audit.record({ ...request, operationId: command.operationId, commandKind: command.kind });
    await audit.complete(command.operationId, { outcome: "failed" });
    await expect(signer.sign(profile.encodeCommand(command))).rejects.toThrow(AuditError);

    // A pending row for a different command kind does not match.
    const other = { ...command, operationId: "1e".repeat(16) as OperationId };
    await audit.record({ ...request, operationId: other.operationId, commandKind: "addZone" });
    await expect(signer.sign(profile.encodeCommand(other))).rejects.toThrow(AuditError);

    expect(kms.calls.length).toBe(before);
  });

  it("NFR-7: no KMS call, and no submission, when the audit row cannot be written", async () => {
    const { organiserId, request } = await createOrganiser(database.store);
    await authority.provision(organiserId, request);
    const refusing = createOrganiserAuthority({
      store: database.store,
      kms,
      audit: { ...audit, record: () => Promise.reject(new AuditError("store unavailable")) },
      ledger: ticketto,
    });
    const before = kms.calls.length;

    const created = await refusing.relay(organiserId, request, (signer) =>
      ticketto.createEvent(signer, {
        salt: new Uint8Array(32).fill(3),
        zones: [],
        capacity: null,
        metadata: null,
      }),
    );

    await expect(created.submission).rejects.toThrow("store unavailable");
    expect(kms.calls.length).toBe(before);
    expect(await ticketto.getEvent(created.id)).toMatchObject({
      ok: false,
      error: { code: "ERR-EventNotFound" },
    });
  });

  it("creates one key when an organiser's first requests arrive together", async () => {
    const { organiserId, request } = await createOrganiser(database.store);

    const accounts = await Promise.all(
      Array.from({ length: 5 }, () => authority.provision(organiserId, request)),
    );

    expect(new Set(accounts).size).toBe(1);
    expect(kms.created.filter((id) => id === organiserId)).toHaveLength(1);
  });

  it("passes on the ledger's verdict when it refuses the registration, and retries it later", async () => {
    const { organiserId, request } = await createOrganiser(database.store);
    let refuse = true;
    const flaky = createOrganiserAuthority({
      store: database.store,
      kms,
      audit,
      ledger: {
        registerCredential: (signer, input) => {
          if (!refuse) return ticketto.registerCredential(signer, input);
          const controller = createSubmission();
          controller.rejected({ code: "ERR-LedgerUnavailable" });
          return controller.submission;
        },
      },
    });

    const refused = flaky.provision(organiserId, request);
    await expect(refused).rejects.toThrow(SpecCodeError);
    await expect(refused).rejects.toMatchObject({ code: "ERR-LedgerUnavailable" });

    refuse = false;
    const account = await flaky.provision(organiserId, request);
    expect(await authority.account(organiserId)).toBe(account);
    expect(kms.created.filter((id) => id === organiserId)).toHaveLength(1);
  });
});
