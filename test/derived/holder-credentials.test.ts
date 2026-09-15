import { randomUUID } from "node:crypto";
import { signProofOfControl } from "@ticketto/profile-v0";
import { simulatedWebAuthnSigner } from "@ticketto/profile-v0/testing";
import type { AccountId, Sponsor, Sponsorship } from "@ticketto/sdk";
import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildApp, TRPC_PREFIX } from "../../src/app.js";
import { createAuth } from "../../src/auth/service.js";
import { createFreshness, type Freshness } from "../../src/derived/freshness.js";
import { ledgerFactsProjection } from "../../src/derived/ledger-facts.js";
import { createDerivedReader, type DerivedReader } from "../../src/derived/reader.js";
import { createReads } from "../../src/derived/reads.js";
import { makeTicketto } from "../../src/ledger/ticketto.js";
import type { Context } from "../../src/trpc/context.js";
import { type AppRouter, appRouter } from "../../src/trpc/router.js";
import { createCallerFactory } from "../../src/trpc/trpc.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { memoryMetadataStorage } from "../support/object-storage.js";

// These tests create databases and write to a ledger: on a loaded machine that
// takes far longer than Vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Placeholder hostnames: the real ones are not chosen yet. */
const LOGIN_RP_ID = "login.kippu.example";
const HOLDER_RP_ID = "holder.kippu.example";

const sponsor: Sponsor = {
  sponsor: async () => ({ ok: true, value: new Uint8Array() as Sponsorship }),
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));

describeWithStore("a holder's own registered credentials", () => {
  let database: TestDatabase;
  let app: FastifyInstance;
  let address: string;
  let freshness: Freshness;
  let reader: DerivedReader;
  const ticketto = makeTicketto({
    environment: "test",
    holderRpId: HOLDER_RP_ID,
    sponsor,
    operationLifetime: 60_000,
  });

  const client = (token?: string) =>
    createTRPCClient<AppRouter>({
      links: [
        httpLink({
          url: `${address}${TRPC_PREFIX}`,
          headers: () => (token === undefined ? {} : { authorization: `Bearer ${token}` }),
        }),
      ],
    });

  async function refusal(call: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await call();
    } catch (error) {
      if (error instanceof TRPCClientError) {
        return (error as TRPCClientError<AppRouter>).data?.code;
      }
      throw error;
    }
    return "OK";
  }

  /** A passkey on a device, registered to `userId`'s account on the ledger. */
  async function device(
    userId?: string,
    authorisedBy?: ReturnType<typeof simulatedWebAuthnSigner>,
  ) {
    const credential = simulatedWebAuthnSigner({
      rpId: HOLDER_RP_ID,
      ...(userId === undefined ? {} : { userId }),
    });
    const registered = await ticketto.registerCredential((authorisedBy ?? credential).signer, {
      account: credential.signer.account,
      registration: credential.registration,
    });
    expect(registered).toMatchObject({ ok: true });
    return credential;
  }

  /** A holder session, linked by proving control of `credential` (`T-020-06`). */
  async function link(credential: ReturnType<typeof simulatedWebAuthnSigner>): Promise<string> {
    const anonymous = client();
    const issued = await anonymous.auth.holder.beginLink.mutate({
      account: credential.signer.account,
    });
    const authorisation = await signProofOfControl(
      {
        audience: fromHex(issued.challenge.audience),
        nonce: fromHex(issued.challenge.nonce),
        expiresAt: issued.challenge.expiresAt,
        account: issued.challenge.account as AccountId,
      },
      credential.signer,
    );
    const { session } = await anonymous.auth.holder.completeLink.mutate({
      challengeId: issued.challengeId,
      authorisation: hex(authorisation),
    });
    return session.token;
  }

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const store = database.store;
    const auth = createAuth({
      store,
      relyingParty: { id: LOGIN_RP_ID, origins: [`https://${LOGIN_RP_ID}`] },
      holders: { credentials: ticketto, holderRpId: HOLDER_RP_ID },
    });
    freshness = createFreshness({ store, pollInterval: 50 });
    reader = createDerivedReader({
      store,
      log: ticketto.log,
      projections: [ledgerFactsProjection(ticketto)],
      onError: () => {},
    });
    const derived = createReads({
      store,
      freshness,
      storage: memoryMetadataStorage(),
      authority: { account: async () => null },
    });
    app = buildApp({}, undefined, { auth, derived });
    address = await app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await app.close();
    await freshness.close();
    await database.drop();
  });

  it("REQ-CP-6: a holder session lists exactly its account's credentials, marking the one it linked with", async () => {
    const phone = await device();
    // A second device of the same holder, authorised by the first (REQ-CP-6).
    const tablet = await device(phone.userId, phone);
    expect(tablet.signer.account).toBe(phone.signer.account);
    const stranger = await device();
    await reader.catchUp();

    const onTablet = client(await link(tablet));
    const read = await onTablet.derived.credentials.mine.query();

    const records = new Map<string, number>();
    let cursor = "" as Parameters<typeof ticketto.log.read>[0];
    for (;;) {
      const page = await ticketto.log.read(cursor, 100);
      if (!page.ok || page.value.records.length === 0) break;
      for (const record of page.value.records) {
        if ("command" in record.entry && record.entry.command.kind === "registerCredential") {
          records.set(hex(record.entry.command.registration), record.recordedAt);
        }
      }
      cursor = page.value.next;
    }
    const idOf = async (credential: ReturnType<typeof simulatedWebAuthnSigner>) => {
      const bytes = await credential.signer.sign(new Uint8Array([1]));
      const { accountOf } = await import("@ticketto/profile-v0");
      const named = accountOf(bytes);
      if (!named.ok) throw new Error(named.error.code);
      return named.value.credential;
    };

    expect(read.credentials).toEqual([
      {
        credential: await idOf(phone),
        registeredAt: records.get(hex(phone.registration)),
        linkedThisSession: false,
        sequence: expect.any(Number),
        authoritative: false,
      },
      {
        credential: await idOf(tablet),
        registeredAt: records.get(hex(tablet.registration)),
        linkedThisSession: true,
        sequence: expect.any(Number),
        authoritative: false,
      },
    ]);
    // Every credential the ledger holds for the account, and no other account's.
    for (const { credential } of read.credentials) {
      expect(await ticketto.getCredential(phone.signer.account, credential as never)).toMatchObject(
        {
          ok: true,
          value: expect.any(Uint8Array),
        },
      );
    }
    expect(read.credentials.map((c) => c.credential)).not.toContain(await idOf(stranger));

    // The same account linked on the phone marks the phone.
    const onPhone = await client(await link(phone)).derived.credentials.mine.query();
    expect(onPhone.credentials.map((c) => c.linkedThisSession)).toEqual([true, false]);

    // Another holder's session lists only its own.
    const theirs = await client(await link(stranger)).derived.credentials.mine.query();
    expect(theirs.credentials).toEqual([
      expect.objectContaining({ credential: await idOf(stranger), linkedThisSession: true }),
    ]);
  });

  it("REQ-CP-6: no other principal can read them", async () => {
    // Organisers and operators, signed in: refused whatever their session.
    const services = { derived: { holderCredentials: () => expect.fail("reached the service") } };
    for (const principal of [
      { kind: "organiser", organiserId: randomUUID(), sessionId: randomUUID() },
      {
        kind: "operator",
        organiserId: randomUUID(),
        operatorId: randomUUID(),
        sessionId: randomUUID(),
      },
    ] as const) {
      const caller = createCallerFactory(appRouter)({
        requestId: "test",
        session: { principal, expiresAt: new Date(Date.now() + 60_000).toISOString() },
        principal,
        services: services as unknown as Context["services"],
      });
      await expect(caller.derived.credentials.mine()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    // Anonymous, or with a token that names no session.
    expect(await refusal(() => client().derived.credentials.mine.query())).toBe("UNAUTHORIZED");
    expect(
      await refusal(() => client(`not-a-session-${randomUUID()}`).derived.credentials.mine.query()),
    ).toBe("UNAUTHORIZED");
  });
});
