import { proofOfControlSigningPayload, signProofOfControl } from "@ticketto/profile-v0";
import { simulatedWebAuthnSigner, softwareP256Signer } from "@ticketto/profile-v0/testing";
import type { AccountId, Signer, Sponsor, Sponsorship } from "@ticketto/sdk";
import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { buildApp, TRPC_PREFIX } from "../../src/app.js";
import type { HolderLinkChallenge } from "../../src/auth/ports.js";
import { createAuth, HOLDER_CHALLENGE_MS, HOLDER_SESSION_MS } from "../../src/auth/service.js";
import { makeTicketto } from "../../src/ledger/ticketto.js";
import { appRouter } from "../../src/trpc/router.js";
import { holderProcedure, mergeRouters, organiserProcedure, router } from "../../src/trpc/trpc.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";

/** Placeholder hostnames: the real ones are not chosen yet. */
const LOGIN_RP_ID = "login.kippu.example";
const HOLDER_RP_ID = "holder.kippu.example";

const sponsor: Sponsor = {
  sponsor: async () => ({ ok: true, value: new Uint8Array() as Sponsorship }),
};

const testRouter = mergeRouters(
  appRouter,
  router({
    probe: router({
      holderOnly: holderProcedure.query(({ ctx }) => ctx.principal.account),
      organiserOnly: organiserProcedure.query(({ ctx }) => ctx.principal.organiserId),
    }),
  }),
);

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));

/** The profile's challenge, from the JSON form kippu-api returns. */
function challengeOf({ challenge }: HolderLinkChallenge) {
  return {
    audience: bytes(challenge.audience),
    nonce: bytes(challenge.nonce),
    expiresAt: challenge.expiresAt,
    account: challenge.account as AccountId,
  };
}

describeWithStore("holder linking by proof of control", () => {
  let database: TestDatabase;
  let app: FastifyInstance;
  let address: string;
  let clock: Date;
  const ticketto = makeTicketto({
    environment: "test",
    holderRpId: HOLDER_RP_ID,
    sponsor,
    operationLifetime: 60_000,
  });

  function client(token?: string) {
    return createTRPCClient<typeof testRouter>({
      links: [
        httpLink({
          url: `${address}${TRPC_PREFIX}`,
          headers: () => (token === undefined ? {} : { authorization: `Bearer ${token}` }),
        }),
      ],
    });
  }

  async function refusal(
    call: () => Promise<unknown>,
  ): Promise<{ code: string | undefined; message: string }> {
    try {
      await call();
    } catch (error) {
      if (error instanceof TRPCClientError) {
        const typed = error as TRPCClientError<typeof testRouter>;
        return { code: typed.data?.code, message: typed.message };
      }
      throw error;
    }
    throw new Error("expected the call to fail");
  }

  /** A holder credential, registered on the ledger through the SDK (`REQ-CP-6`). */
  async function registeredHolder(
    options: { secretKey?: Uint8Array; credentialId?: Uint8Array } = {},
  ) {
    const holder = simulatedWebAuthnSigner({ rpId: HOLDER_RP_ID, ...options });
    const registered = await ticketto.registerCredential(holder.signer, {
      account: holder.signer.account,
      registration: holder.registration,
    });
    expect(registered.ok).toBe(true);
    return holder;
  }

  async function link(signer: Signer, account: string = signer.account) {
    const anonymous = client();
    const issued = await anonymous.auth.holder.beginLink.mutate({ account });
    const authorisation = await signer.sign(proofOfControlSigningPayload(challengeOf(issued)));
    return anonymous.auth.holder.completeLink.mutate({
      challengeId: issued.challengeId,
      authorisation: hex(authorisation),
    });
  }

  const THE_REFUSAL = { code: "UNAUTHORIZED", message: "the proof of control was refused" };

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const auth = createAuth({
      store: database.store,
      relyingParty: { id: LOGIN_RP_ID, origins: [`https://${LOGIN_RP_ID}`] },
      holders: { credentials: ticketto, holderRpId: HOLDER_RP_ID },
      now: () => clock,
    });
    app = buildApp({}, testRouter, { auth });
    address = await app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  beforeEach(() => {
    clock = new Date();
  });

  it("REQ-SP-4: linking succeeds with a valid holder signature, and opens a 30-day holder session", async () => {
    const holder = await registeredHolder();

    const anonymous = client();
    const issued = await anonymous.auth.holder.beginLink.mutate({ account: holder.signer.account });
    expect(new TextDecoder().decode(bytes(issued.challenge.audience))).toBe(
      `kippu-api@${LOGIN_RP_ID}`,
    );
    expect(issued.challenge.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.challenge.expiresAt).toBe(clock.getTime() + HOLDER_CHALLENGE_MS);

    const authorisation = await signProofOfControl(challengeOf(issued), holder.signer);
    const { session, holder: linked } = await anonymous.auth.holder.completeLink.mutate({
      challengeId: issued.challengeId,
      authorisation: hex(authorisation),
    });

    expect(linked).toEqual({ account: holder.signer.account });
    expect(session.expiresAt).toBe(new Date(clock.getTime() + HOLDER_SESSION_MS).toISOString());
    const signedIn = client(session.token);
    await expect(signedIn.probe.holderOnly.query()).resolves.toBe(holder.signer.account);
    expect((await signedIn.auth.session.current.query()).principal).toMatchObject({
      kind: "holder",
      account: holder.signer.account,
    });
    expect((await refusal(() => signedIn.probe.organiserOnly.query())).code).toBe("FORBIDDEN");
  });

  it("REQ-SP-4: linking fails with another account's signature", async () => {
    const holder = await registeredHolder();
    const other = await registeredHolder();

    expect(await refusal(() => link(other.signer, holder.signer.account))).toEqual(THE_REFUSAL);
  });

  it("REQ-CP-6: refuses a credential the ledger has no registration for", async () => {
    const unregistered = simulatedWebAuthnSigner({ rpId: HOLDER_RP_ID });

    expect(await refusal(() => link(unregistered.signer))).toEqual(THE_REFUSAL);
  });

  it("refuses a p256 credential, even one registered on the ledger", async () => {
    const kippuHeld = softwareP256Signer();
    const registered = await ticketto.registerCredential(kippuHeld.signer, {
      account: kippuHeld.signer.account,
      registration: kippuHeld.registration,
    });
    expect(registered.ok).toBe(true);

    expect(await refusal(() => link(kippuHeld.signer))).toEqual(THE_REFUSAL);
  });

  it("refuses an assertion made for another RP id with a registered device", async () => {
    const secretKey = new Uint8Array(32).fill(9);
    const credentialId = new Uint8Array(32).fill(4);
    const holder = await registeredHolder({ secretKey, credentialId });
    const sameDeviceOtherRp = simulatedWebAuthnSigner({
      rpId: LOGIN_RP_ID,
      userId: holder.userId,
      secretKey,
      credentialId,
    });

    expect(await refusal(() => link(sameDeviceOtherRp.signer))).toEqual(THE_REFUSAL);
  });

  it("a challenge answers once, not after it expires, and only for its own audience", async () => {
    const holder = await registeredHolder();
    const anonymous = client();

    const used = await anonymous.auth.holder.beginLink.mutate({ account: holder.signer.account });
    const answer = hex(await signProofOfControl(challengeOf(used), holder.signer));
    await anonymous.auth.holder.completeLink.mutate({
      challengeId: used.challengeId,
      authorisation: answer,
    });
    expect(
      await refusal(() =>
        anonymous.auth.holder.completeLink.mutate({
          challengeId: used.challengeId,
          authorisation: answer,
        }),
      ),
    ).toEqual(THE_REFUSAL);

    const stale = await anonymous.auth.holder.beginLink.mutate({ account: holder.signer.account });
    const staleAnswer = hex(await signProofOfControl(challengeOf(stale), holder.signer));
    clock = new Date(clock.getTime() + HOLDER_CHALLENGE_MS);
    expect(
      await refusal(() =>
        anonymous.auth.holder.completeLink.mutate({
          challengeId: stale.challengeId,
          authorisation: staleAnswer,
        }),
      ),
    ).toEqual(THE_REFUSAL);

    const foreign = await anonymous.auth.holder.beginLink.mutate({
      account: holder.signer.account,
    });
    const forOtherAudience = {
      ...challengeOf(foreign),
      audience: new TextEncoder().encode("another-verifier"),
    };
    expect(
      await refusal(async () =>
        anonymous.auth.holder.completeLink.mutate({
          challengeId: foreign.challengeId,
          authorisation: hex(await signProofOfControl(forOtherAudience, holder.signer)),
        }),
      ),
    ).toEqual(THE_REFUSAL);
  });

  it("refuses bytes that are not an authorisation, and an unknown challenge, the same way", async () => {
    const holder = await registeredHolder();
    const issued = await client().auth.holder.beginLink.mutate({ account: holder.signer.account });

    expect(
      await refusal(() =>
        client().auth.holder.completeLink.mutate({
          challengeId: issued.challengeId,
          authorisation: "00ff",
        }),
      ),
    ).toEqual(THE_REFUSAL);
    const genuine = hex(await signProofOfControl(challengeOf(issued), holder.signer));
    expect(
      await refusal(() =>
        client().auth.holder.completeLink.mutate({
          challengeId: "7a0f0c1e-5b3d-4c1f-9e2a-6b8d0f4c2a91",
          authorisation: genuine,
        }),
      ),
    ).toEqual(THE_REFUSAL);
  });

  it("a holder session ends after 30 days, or on sign-out", async () => {
    const holder = await registeredHolder();

    const expiring = await link(holder.signer);
    clock = new Date(clock.getTime() + HOLDER_SESSION_MS);
    expect(
      (await refusal(() => client(expiring.session.token).probe.holderOnly.query())).code,
    ).toBe("UNAUTHORIZED");

    clock = new Date();
    const { session } = await link(holder.signer);
    await client(session.token).auth.session.signOut.mutate();
    expect((await refusal(() => client(session.token).probe.holderOnly.query())).code).toBe(
      "UNAUTHORIZED",
    );
  });
});
