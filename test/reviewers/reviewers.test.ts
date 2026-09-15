import { randomUUID } from "node:crypto";
import type { OperationId } from "@ticketto/sdk";
import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { buildApp, TRPC_PREFIX } from "../../src/app.js";
import { createAuditLog } from "../../src/audit/audit-log.js";
import { createAuth, ORGANISER_SESSION_MS } from "../../src/auth/service.js";
import {
  createReviewers,
  REVIEWER_ENROLMENT_CODE_MS,
  REVIEWER_SESSION_MS,
} from "../../src/reviewers/service.js";
import { appRouter } from "../../src/trpc/router.js";
import {
  mergeRouters,
  organiserProcedure,
  reviewerProcedure,
  router,
} from "../../src/trpc/trpc.js";
import { SoftwareAuthenticator } from "../support/authenticator.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";

// Store-backed: generous timeouts, so a loaded CI host or database does not fail the suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Placeholder hostnames: the real ones are not chosen yet. */
const LOGIN_RP_ID = "login.kippu.example";
const IBENTO = "https://ibento.login.kippu.example";
const HOUR = 60 * 60 * 1000;

/** The root router, plus a probe per principal, as the review queue (T-021-08) will add one. */
const testRouter = mergeRouters(
  appRouter,
  router({
    probe: router({
      reviewerOnly: reviewerProcedure.query(({ ctx }) => ctx.principal.reviewerId),
      organiserOnly: organiserProcedure.query(({ ctx }) => ctx.principal.organiserId),
    }),
  }),
);

describeWithStore("reviewer accounts", () => {
  let database: TestDatabase;
  let app: FastifyInstance;
  let address: string;
  let clock: Date;
  let reviewers: ReturnType<typeof createReviewers>;
  let emails = 0;
  const freshEmail = () => `Reviewer${++emails}@Kippu.example`;

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

  /** A reviewer created from the command line, then enrolled with a passkey. */
  async function enrolled(email = freshEmail()) {
    const created = await reviewers.create(email);
    const passkey = new SoftwareAuthenticator({ origin: IBENTO });
    const anonymous = client();
    const challenge = await anonymous.reviewers.enrolment.begin.mutate({
      code: created.code,
      email,
    });
    const result = await anonymous.reviewers.enrolment.complete.mutate({
      ceremonyId: challenge.ceremonyId,
      credential: passkey.create(challenge.options),
    });
    return { email, created, passkey, ...result };
  }

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const now = () => clock;
    const auth = createAuth({
      store: database.store,
      relyingParty: { id: LOGIN_RP_ID, origins: [IBENTO] },
      now,
    });
    reviewers = createReviewers({
      store: database.store,
      relyingParty: { id: LOGIN_RP_ID, origins: [IBENTO] },
      now,
    });
    app = buildApp({}, testRouter, { auth, reviewers });
    address = await app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  beforeEach(() => {
    clock = new Date("2026-09-16T09:00:00Z");
  });

  it("REQ-EV-6: a reviewer created from the command line enrols with the code, their email and a passkey, and signs in", async () => {
    const email = freshEmail();
    const created = await reviewers.create(email);
    expect(created.reviewer.email).toBe(email.toLowerCase());
    expect(created.codeExpiresAt).toBe(
      new Date(clock.getTime() + REVIEWER_ENROLMENT_CODE_MS).toISOString(),
    );

    const { session, reviewer, passkey } = await (async () => {
      const key = new SoftwareAuthenticator({ origin: IBENTO });
      const challenge = await client().reviewers.enrolment.begin.mutate({
        code: created.code,
        email,
      });
      // The passkey is bound to Kippu's login RP id, and must be user-verified.
      expect(challenge.options.rp.id).toBe(LOGIN_RP_ID);
      expect(challenge.options.authenticatorSelection?.userVerification).toBe("required");
      const done = await client().reviewers.enrolment.complete.mutate({
        ceremonyId: challenge.ceremonyId,
        credential: key.create(challenge.options),
      });
      return { ...done, passkey: key };
    })();
    expect(reviewer).toEqual(created.reviewer);
    expect(session.expiresAt).toBe(new Date(clock.getTime() + REVIEWER_SESSION_MS).toISOString());
    expect(REVIEWER_SESSION_MS).toBe(12 * HOUR);
    await expect(client(session.token).probe.reviewerOnly.query()).resolves.toBe(reviewer.id);
    expect((await client(session.token).auth.session.current.query()).principal).toEqual({
      kind: "reviewer",
      reviewerId: reviewer.id,
      sessionId: expect.any(String),
    });

    // Signing in again, with the passkey attested at enrolment.
    const signIn = await client().reviewers.signIn.begin.mutate({ email });
    const again = await client().reviewers.signIn.complete.mutate({
      ceremonyId: signIn.ceremonyId,
      credential: passkey.get(signIn.options),
    });
    await expect(client(again.session.token).probe.reviewerOnly.query()).resolves.toBe(reviewer.id);

    // A reviewer session lasts 12 hours.
    clock = new Date(clock.getTime() + REVIEWER_SESSION_MS + 1);
    expect(await failure(() => client(again.session.token).probe.reviewerOnly.query())).toBe(
      "UNAUTHORIZED",
    );
  });

  it("an enrolment code redeems once, only with its reviewer's email, and not once expired or reissued", async () => {
    const email = freshEmail();
    const created = await reviewers.create(email);
    const begin = (code: string, as = email) =>
      client().reviewers.enrolment.begin.mutate({ code, email: as });

    expect(await failure(() => begin(created.code, freshEmail()))).toBe("UNAUTHORIZED");
    expect(await failure(() => begin("not-a-code"))).toBe("UNAUTHORIZED");

    // Reissued, the first code is void.
    const reissued = await reviewers.reissueCode(email);
    expect(await failure(() => begin(created.code))).toBe("UNAUTHORIZED");

    const key = new SoftwareAuthenticator({ origin: IBENTO });
    const challenge = await begin(reissued.code);
    await client().reviewers.enrolment.complete.mutate({
      ceremonyId: challenge.ceremonyId,
      credential: key.create(challenge.options),
    });
    expect(await failure(() => begin(reissued.code))).toBe("UNAUTHORIZED");

    const late = await reviewers.create(freshEmail());
    clock = new Date(clock.getTime() + REVIEWER_ENROLMENT_CODE_MS + 1);
    expect(await failure(() => begin(late.code, late.reviewer.email))).toBe("UNAUTHORIZED");
    await expect(reviewers.create(email)).rejects.toThrow(/already uses/);
  });

  it("an organiser session can never reach a reviewer procedure, nor a reviewer session an organiser's", async () => {
    const organiserKey = new SoftwareAuthenticator({ origin: IBENTO });
    const signUp = await client().auth.organiser.beginSignUp.mutate({ email: freshEmail() });
    const organiser = await client().auth.organiser.completeSignUp.mutate({
      ceremonyId: signUp.ceremonyId,
      credential: organiserKey.create(signUp.options),
    });
    expect(organiser.session.expiresAt).toBe(
      new Date(clock.getTime() + ORGANISER_SESSION_MS).toISOString(),
    );
    const { session } = await enrolled();

    expect(await failure(() => client(organiser.session.token).probe.reviewerOnly.query())).toBe(
      "FORBIDDEN",
    );
    expect(await failure(() => client(session.token).probe.organiserOnly.query())).toBe(
      "FORBIDDEN",
    );
    expect(
      await failure(() =>
        client(session.token).events.classes.list.query({ event: "ab".repeat(32) }),
      ),
    ).toBe("FORBIDDEN");
    // A reviewer's email is not an organiser's: organiser sign-in does not know it.
    const reviewerEmail = emails;
    expect(
      await failure(() =>
        client().auth.organiser.beginSignIn.mutate({
          email: `Reviewer${reviewerEmail}@Kippu.example`,
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("disabling a reviewer ends their sessions at once, and they can no longer sign in or enrol", async () => {
    const { email, session, passkey } = await enrolled();
    const pending = await reviewers.create(freshEmail());

    const disabled = await reviewers.disable(email);
    expect(disabled.sessionsEnded).toBe(1);
    expect(await failure(() => client(session.token).probe.reviewerOnly.query())).toBe(
      "UNAUTHORIZED",
    );
    expect(await failure(() => client().reviewers.signIn.begin.mutate({ email }))).toBe(
      "NOT_FOUND",
    );

    // A sign-in begun before the reviewer was disabled cannot be completed after.
    const other = await enrolled();
    const signIn = await client().reviewers.signIn.begin.mutate({ email: other.email });
    await reviewers.disable(other.email);
    expect(
      await failure(() =>
        client().reviewers.signIn.complete.mutate({
          ceremonyId: signIn.ceremonyId,
          credential: other.passkey.get(signIn.options),
        }),
      ),
    ).toBe("UNAUTHORIZED");

    await reviewers.disable(pending.reviewer.email);
    expect(
      await failure(() =>
        client().reviewers.enrolment.begin.mutate({
          code: pending.code,
          email: pending.reviewer.email,
        }),
      ),
    ).toBe("UNAUTHORIZED");
    void passkey;
  });

  it("NFR-7: a reviewer's relayed write is attributed to the reviewer and their session", async () => {
    const audit = createAuditLog(database.store);
    const principal = {
      kind: "reviewer" as const,
      reviewerId: randomUUID(),
      sessionId: randomUUID(),
    };
    const operationId = "7a".repeat(16) as OperationId;

    await audit.record({
      requestId: "req-review",
      principal,
      operationId,
      commandKind: "setEventCapacity",
    });

    expect(await audit.find(operationId)).toMatchObject({ requestId: "req-review", principal });
    const row = await database.store.query(
      "SELECT principal_kind, reviewer_id, session_id, organiser_id FROM audit_log WHERE operation_id = $1",
      [operationId],
    );
    expect(row.rows).toEqual([
      {
        principal_kind: "reviewer",
        reviewer_id: principal.reviewerId,
        session_id: principal.sessionId,
        organiser_id: null,
      },
    ]);
  });
});
