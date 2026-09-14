import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { buildApp, TRPC_PREFIX } from "../../src/app.js";
import type { Auth } from "../../src/auth/ports.js";
import {
  CEREMONY_MS,
  createAuth,
  OPERATOR_SESSION_MS,
  ORGANISER_SESSION_MS,
} from "../../src/auth/service.js";
import { appRouter } from "../../src/trpc/router.js";
import {
  mergeRouters,
  operatorProcedure,
  organiserProcedure,
  router,
} from "../../src/trpc/trpc.js";
import { SoftwareAuthenticator } from "../support/authenticator.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { issueEnrolmentCode } from "../support/operators.js";

/** Placeholder hostnames: the real ones are not chosen yet. */
const LOGIN_RP_ID = "login.kippu.example";
const HOLDER_RP_ID = "holder.kippu.example";
const IBENTO = "https://ibento.login.kippu.example";

/** The root router, plus one procedure per principal, as domain routers will add them. */
const testRouter = mergeRouters(
  appRouter,
  router({
    probe: router({
      organiserOnly: organiserProcedure.query(({ ctx }) => ctx.principal.organiserId),
      operatorOnly: operatorProcedure.query(({ ctx }) => ctx.principal.operatorId),
    }),
  }),
);

describeWithStore("organiser and operator sessions", () => {
  let database: TestDatabase;
  let app: FastifyInstance;
  let auth: Auth;
  let address: string;
  let clock: Date;

  const HOUR = 60 * 60 * 1000;
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

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

  async function failure(call: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await call();
    } catch (error) {
      if (error instanceof TRPCClientError) {
        return (error as TRPCClientError<typeof testRouter>).data?.code;
      }
      throw error;
    }
    throw new Error("expected the call to fail");
  }

  let emailCounter = 0;
  const freshEmail = () => `Organiser${++emailCounter}@Example.test`;

  async function signUp(authenticator = new SoftwareAuthenticator({ origin: IBENTO })) {
    const email = freshEmail();
    const anonymous = client();
    const challenge = await anonymous.auth.organiser.beginSignUp.mutate({ email });
    const result = await anonymous.auth.organiser.completeSignUp.mutate({
      ceremonyId: challenge.ceremonyId,
      credential: authenticator.create(challenge.options),
    });
    return { email, authenticator, ...result };
  }

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    auth = createAuth({
      store: database.store,
      relyingParty: { id: LOGIN_RP_ID, origins: [IBENTO] },
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
    clock = new Date("2026-09-14T09:00:00Z");
  });

  // --- Organisers --------------------------------------------------------------------------

  it("an organiser signs up with an email and a passkey, and receives a 12-hour session", async () => {
    const { email, session, organiser } = await signUp();

    expect(organiser.email).toBe(email.toLowerCase());
    expect(session.expiresAt).toBe(new Date(clock.getTime() + ORGANISER_SESSION_MS).toISOString());
    const current = await client(session.token).auth.session.current.query();
    expect(current.principal).toMatchObject({ kind: "organiser", organiserId: organiser.id });
  });

  it("the sign-up challenge asks for user verification on the login RP id", async () => {
    const { options } = await client().auth.organiser.beginSignUp.mutate({ email: freshEmail() });

    expect(options.rp.id).toBe(LOGIN_RP_ID);
    expect(options.authenticatorSelection?.userVerification).toBe("required");
  });

  it("an organiser signs in again with the passkey attested at sign-up", async () => {
    const { email, authenticator, organiser } = await signUp();
    const anonymous = client();

    const challenge = await anonymous.auth.organiser.beginSignIn.mutate({ email });
    expect(challenge.options.allowCredentials?.map((c) => c.id)).toEqual([authenticator.id]);
    const { session } = await anonymous.auth.organiser.completeSignIn.mutate({
      ceremonyId: challenge.ceremonyId,
      credential: authenticator.get(challenge.options),
    });

    await expect(client(session.token).probe.organiserOnly.query()).resolves.toBe(organiser.id);
  });

  it("refuses a second account for the same email, whatever its case", async () => {
    const { email } = await signUp();

    expect(
      await failure(() =>
        client().auth.organiser.beginSignUp.mutate({ email: email.toUpperCase() }),
      ),
    ).toBe("CONFLICT");
  });

  it("refuses sign-in for an email with no account", async () => {
    expect(
      await failure(() => client().auth.organiser.beginSignIn.mutate({ email: freshEmail() })),
    ).toBe("NOT_FOUND");
  });

  it("refuses sign-in with a passkey that is not the organiser's", async () => {
    const { email } = await signUp();
    const other = await signUp();
    const anonymous = client();

    const challenge = await anonymous.auth.organiser.beginSignIn.mutate({ email });
    expect(
      await failure(() =>
        anonymous.auth.organiser.completeSignIn.mutate({
          ceremonyId: challenge.ceremonyId,
          credential: other.authenticator.get(challenge.options),
        }),
      ),
    ).toBe("UNAUTHORIZED");
  });

  it("refuses an assertion made for the holder credential's RP id", async () => {
    const { email, authenticator } = await signUp();
    const anonymous = client();

    const challenge = await anonymous.auth.organiser.beginSignIn.mutate({ email });
    expect(
      await failure(() =>
        anonymous.auth.organiser.completeSignIn.mutate({
          ceremonyId: challenge.ceremonyId,
          credential: authenticator.get(challenge.options, HOLDER_RP_ID),
        }),
      ),
    ).toBe("UNAUTHORIZED");
  });

  it("refuses a passkey without user verification, and one from another origin", async () => {
    for (const authenticator of [
      new SoftwareAuthenticator({ origin: IBENTO, withoutUserVerification: true }),
      new SoftwareAuthenticator({ origin: "https://phishing.example" }),
    ]) {
      const anonymous = client();
      const challenge = await anonymous.auth.organiser.beginSignUp.mutate({ email: freshEmail() });
      expect(
        await failure(() =>
          anonymous.auth.organiser.completeSignUp.mutate({
            ceremonyId: challenge.ceremonyId,
            credential: authenticator.create(challenge.options),
          }),
        ),
      ).toBe("UNAUTHORIZED");
    }
  });

  it("a challenge answers once, and not after it expires", async () => {
    const { email, authenticator } = await signUp();
    const anonymous = client();

    const used = await anonymous.auth.organiser.beginSignIn.mutate({ email });
    const credential = authenticator.get(used.options);
    await anonymous.auth.organiser.completeSignIn.mutate({
      ceremonyId: used.ceremonyId,
      credential,
    });
    expect(
      await failure(() =>
        anonymous.auth.organiser.completeSignIn.mutate({ ceremonyId: used.ceremonyId, credential }),
      ),
    ).toBe("UNAUTHORIZED");

    const stale = await anonymous.auth.organiser.beginSignIn.mutate({ email });
    advance(CEREMONY_MS + 1);
    expect(
      await failure(() =>
        anonymous.auth.organiser.completeSignIn.mutate({
          ceremonyId: stale.ceremonyId,
          credential: authenticator.get(stale.options),
        }),
      ),
    ).toBe("UNAUTHORIZED");
  });

  it("an organiser session ends after 12 hours", async () => {
    const { session } = await signUp();

    advance(ORGANISER_SESSION_MS - 1);
    await expect(client(session.token).auth.session.current.query()).resolves.toBeDefined();
    advance(1);
    expect(await failure(() => client(session.token).auth.session.current.query())).toBe(
      "UNAUTHORIZED",
    );
  });

  it("an organiser signs out, and the token stops working", async () => {
    const { session } = await signUp();
    const signedIn = client(session.token);

    await expect(signedIn.auth.session.signOut.mutate()).resolves.toEqual({ signedOut: true });
    expect(await failure(() => signedIn.auth.session.current.query())).toBe("UNAUTHORIZED");
  });

  it("an organiser may not call an operator's procedure", async () => {
    const { session } = await signUp();

    expect(await failure(() => client(session.token).probe.operatorOnly.query())).toBe("FORBIDDEN");
  });

  // --- Operators ---------------------------------------------------------------------------

  it("REQ-OP-1: an operator redeems an enrolment code for a 24-hour session under their organiser", async () => {
    const { organiser } = await signUp();
    const { operatorId, code } = await issueEnrolmentCode(database.store, {
      organiserId: organiser.id,
      expiresAt: new Date(clock.getTime() + HOUR),
    });

    const { session, operator } = await client().auth.operator.redeemEnrolmentCode.mutate({ code });

    expect(operator).toEqual({ id: operatorId, organiserId: organiser.id });
    expect(session.expiresAt).toBe(new Date(clock.getTime() + OPERATOR_SESSION_MS).toISOString());
    const signedIn = client(session.token);
    await expect(signedIn.probe.operatorOnly.query()).resolves.toBe(operatorId);
    expect((await signedIn.auth.session.current.query()).principal).toMatchObject({
      kind: "operator",
      operatorId,
      organiserId: organiser.id,
    });
  });

  it("an enrolment code redeems once, and not after it expires", async () => {
    const { organiser } = await signUp();
    const once = await issueEnrolmentCode(database.store, {
      organiserId: organiser.id,
      expiresAt: new Date(clock.getTime() + HOUR),
    });
    await client().auth.operator.redeemEnrolmentCode.mutate({ code: once.code });
    expect(
      await failure(() => client().auth.operator.redeemEnrolmentCode.mutate({ code: once.code })),
    ).toBe("UNAUTHORIZED");

    const stale = await issueEnrolmentCode(database.store, {
      organiserId: organiser.id,
      expiresAt: new Date(clock.getTime() + HOUR),
    });
    advance(HOUR);
    expect(
      await failure(() => client().auth.operator.redeemEnrolmentCode.mutate({ code: stale.code })),
    ).toBe("UNAUTHORIZED");
    expect(
      await failure(() =>
        client().auth.operator.redeemEnrolmentCode.mutate({ code: "not-a-code" }),
      ),
    ).toBe("UNAUTHORIZED");
  });

  it("an operator session ends after 24 hours, or when it is revoked", async () => {
    const { organiser } = await signUp();
    const issue = () =>
      issueEnrolmentCode(database.store, {
        organiserId: organiser.id,
        expiresAt: new Date(clock.getTime() + HOUR),
      });

    const expiring = await client().auth.operator.redeemEnrolmentCode.mutate({
      code: (await issue()).code,
    });
    advance(OPERATOR_SESSION_MS - 1);
    await expect(client(expiring.session.token).probe.operatorOnly.query()).resolves.toBeDefined();
    advance(1);
    expect(await failure(() => client(expiring.session.token).probe.operatorOnly.query())).toBe(
      "UNAUTHORIZED",
    );

    const revoked = await client().auth.operator.redeemEnrolmentCode.mutate({
      code: (await issue()).code,
    });
    const info = await auth.authenticate(revoked.session.token);
    await auth.signOut(info?.principal.sessionId as string);
    expect(await failure(() => client(revoked.session.token).probe.operatorOnly.query())).toBe(
      "UNAUTHORIZED",
    );
  });

  it("an operator may not call an organiser's procedure", async () => {
    const { organiser } = await signUp();
    const { code } = await issueEnrolmentCode(database.store, {
      organiserId: organiser.id,
      expiresAt: new Date(clock.getTime() + HOUR),
    });
    const { session } = await client().auth.operator.redeemEnrolmentCode.mutate({ code });

    expect(await failure(() => client(session.token).probe.organiserOnly.query())).toBe(
      "FORBIDDEN",
    );
  });

  // --- Tokens ------------------------------------------------------------------------------

  it("a call with no token, or an unknown or malformed one, has no session", async () => {
    for (const token of [undefined, "A".repeat(43), "not a token"]) {
      expect(await failure(() => client(token).auth.session.current.query())).toBe("UNAUTHORIZED");
      expect(await failure(() => client(token).probe.organiserOnly.query())).toBe("UNAUTHORIZED");
    }
  });

  it("stores only a hash of each session token", async () => {
    const { session } = await signUp();
    const stored = await database.store.query<{ token_hash: Buffer }>(
      "SELECT token_hash FROM sessions",
    );

    expect(stored.rows.length).toBeGreaterThan(0);
    for (const row of stored.rows) {
      expect(row.token_hash.toString("base64url")).not.toBe(session.token);
      expect(row.token_hash.toString("utf8")).not.toContain(session.token);
    }
  });
});
