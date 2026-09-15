import { registrationAccount } from "@ticketto/profile-v0";
import { simulatedWebAuthnSigner, softwareP256Signer } from "@ticketto/profile-v0/testing";
import type { AccountId, Authorisation, OperationId, Registration } from "@ticketto/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ledgerFactsProjection, UnprojectableRecordError } from "../../src/derived/ledger-facts.js";
import { createDerivedQueries } from "../../src/derived/queries.js";
import { createDerivedReader } from "../../src/derived/reader.js";
import { connectRelayDerivedCopy } from "../../src/sponsor/derived.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { derivedSnapshot, scriptedLog, wholeLog } from "../support/derived.js";
import {
  HOLDER_RP_ID,
  type MemoryLedger,
  memoryLedger,
  settled,
} from "../support/memory-ledger.js";
import { relayLoginRole } from "../support/sponsor-relay.js";

const bytes = (length: number, byte: number) => new Uint8Array(length).fill(byte);

// These tests create databases and write to a ledger: on a loaded machine that
// takes far longer than Vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describeWithStore("the derived copy's credential registrations", () => {
  let database: TestDatabase;
  let ledger: MemoryLedger;

  beforeEach(async () => {
    database = await createMigratedTestDatabase();
    ledger = memoryLedger();
  });

  afterEach(async () => {
    await database.drop();
  });

  const reader = (log = ledger.kippu.log, batchSize = 3) =>
    createDerivedReader({
      store: database.store,
      log,
      projections: [ledgerFactsProjection(ledger.kippu)],
      batchSize,
      onError: () => {},
    });

  /** The account and credential id the profile derives from a registration. */
  function idsOf(registration: Registration) {
    const named = registrationAccount(registration);
    if (!named.ok) throw new Error(named.error.code);
    return named.value;
  }

  it("REQ-CP-6: registrations in the copy equal getCredential for every registered credential", async () => {
    const { direct } = ledger;
    // An organiser's p256 credential, and two holders' passkeys.
    await ledger.registerOrganiser();
    const alice = simulatedWebAuthnSigner({
      rpId: HOLDER_RP_ID,
      secretKey: bytes(32, 0x21),
      credentialId: bytes(16, 0x21),
    });
    const bob = simulatedWebAuthnSigner({
      rpId: HOLDER_RP_ID,
      secretKey: bytes(32, 0x22),
      credentialId: bytes(16, 0x22),
    });
    for (const holder of [alice, bob]) {
      await settled(
        direct.registerCredential(holder.signer, {
          account: holder.signer.account,
          registration: holder.registration,
        }),
      );
    }
    // Alice's second device: the same user, another key, authorised by her first.
    const aliceSecondDevice = simulatedWebAuthnSigner({
      rpId: HOLDER_RP_ID,
      userId: alice.userId,
      secretKey: bytes(32, 0x23),
      credentialId: bytes(16, 0x23),
    });
    expect(aliceSecondDevice.signer.account).toBe(alice.signer.account);
    await settled(
      direct.registerCredential(alice.signer, {
        account: alice.signer.account,
        registration: aliceSecondDevice.registration,
      }),
    );
    // Registering a credential already registered is accepted, and changes nothing.
    await settled(
      direct.registerCredential(bob.signer, {
        account: bob.signer.account,
        registration: bob.registration,
      }),
    );

    const records = await wholeLog(ledger.kippu.log);
    expect(await reader().catchUp()).toBe(records.length);

    const queries = createDerivedQueries(database.store);
    const registered = [ledger.organiser, alice, bob, aliceSecondDevice];
    for (const { registration } of registered) {
      const { account, credential } = idsOf(registration);
      const onLedger = await ledger.kippu.getCredential(account, credential);
      expect(onLedger.ok).toBe(true);
      const copy = await queries.credential(account, credential);
      expect(copy.result?.value).toEqual(onLedger.ok ? onLedger.value : undefined);
      expect(copy.result?.authoritative).toBe(false);
    }

    // Both of Alice's devices, in registration order; Bob's re-registration added nothing.
    const aliceCredentials = await queries.credentials(alice.signer.account);
    expect(aliceCredentials.result.map((c) => c.value.credential)).toEqual([
      idsOf(alice.registration).credential,
      idsOf(aliceSecondDevice.registration).credential,
    ]);
    const bobCredentials = await queries.credentials(bob.signer.account);
    expect(bobCredentials.result).toHaveLength(1);
    const bobFirst = records.findIndex(
      (record) =>
        "command" in record.entry &&
        record.entry.command.kind === "registerCredential" &&
        record.entry.command.account === bob.signer.account,
    );
    expect(bobCredentials.result[0]?.sequence).toBe(bobFirst);

    // Neither answers for a credential never registered, or one of another account.
    const stranger = softwareP256Signer({ secretKey: bytes(32, 0x99) });
    const unregistered = idsOf(stranger.registration);
    for (const [account, credential] of [
      [unregistered.account, unregistered.credential],
      [bob.signer.account, idsOf(alice.registration).credential],
    ] as const) {
      expect(await ledger.kippu.getCredential(account, credential)).toEqual({
        ok: true,
        value: null,
      });
      expect((await queries.credential(account, credential)).result).toBeNull();
    }
    expect((await queries.credentials(unregistered.account)).result).toEqual([]);
  });

  it("the sponsor relay's read-only role reads registrations, for verifying before it sponsors", async () => {
    await ledger.registerOrganiser();
    await reader().catchUp();
    const { account, credential } = idsOf(ledger.organiser.registration);
    const role = await relayLoginRole(database.url);
    const relay = connectRelayDerivedCopy(role.url);
    try {
      expect((await relay.queries.credential(account, credential)).result?.value).toEqual(
        ledger.organiser.registration,
      );
    } finally {
      await relay.close();
      await role.drop();
    }
  });

  it("NFR-11: a rebuild from cursor zero, in any batch size, yields identical registrations", async () => {
    await ledger.registerOrganiser();
    await ledger.registerHolder(0x31);
    await ledger.registerHolder(0x32);
    const { log } = scriptedLog(
      (await wholeLog(ledger.kippu.log)).map(({ cursor: _, ...record }) => record),
    );
    const other = await createMigratedTestDatabase();
    try {
      await reader().catchUp();
      await createDerivedReader({
        store: other.store,
        log,
        projections: [ledgerFactsProjection(ledger.kippu)],
        batchSize: 1,
        onError: () => {},
      }).catchUp();
      const rows = await database.store.query("SELECT count(*)::int AS n FROM derived_credentials");
      expect(rows.rows[0]).toEqual({ n: 3 });
      expect(await derivedSnapshot(other.store)).toEqual(await derivedSnapshot(database.store));
    } finally {
      await other.drop();
    }
  });

  it("a registration the profile cannot decode stops the reader, and is never skipped", async () => {
    await ledger.registerOrganiser();
    const prefix = (await wholeLog(ledger.kippu.log)).map(({ cursor: _, ...record }) => record);
    const forged = {
      recordedAt: (prefix.at(-1)?.recordedAt ?? 0) + 1,
      event: null,
      entry: {
        command: {
          kind: "registerCredential" as const,
          operationId: "ab".repeat(16) as OperationId,
          expiresAt: 1_900_000_000_000,
          account: "cd".repeat(32) as AccountId,
          registration: bytes(8, 0) as Registration,
        },
        authorisation: bytes(0, 0) as Authorisation,
      },
      presentedAt: null,
    };
    const { log } = scriptedLog([...prefix, forged]);
    const copy = reader(log, 1);
    await copy.step();
    await expect(copy.catchUp()).rejects.toBeInstanceOf(UnprojectableRecordError);
    expect(
      (await createDerivedQueries(database.store).credentials("cd".repeat(32) as AccountId)).result,
    ).toEqual([]);
    expect((await copy.position()).nextSequence).toBe(prefix.length);
    // Retrying does not get past it either.
    await expect(copy.step()).rejects.toBeInstanceOf(UnprojectableRecordError);
    expect((await copy.position()).nextSequence).toBe(prefix.length);
  });
});
