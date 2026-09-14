import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, TRPC_PREFIX } from "../src/app.js";
import { toTRPCError } from "../src/trpc/errors.js";
import { appRouter } from "../src/trpc/router.js";
import { mergeRouters, publicProcedure, router } from "../src/trpc/trpc.js";

/**
 * A router that extends the root router with sample procedures failing the way
 * a domain procedure will once the SDK is wired in: with an error shaped
 * `{ code }` carrying a `SPEC.md` §10 code.
 */
const testRouter = mergeRouters(
  appRouter,
  router({
    sample: router({
      eventNotFound: publicProcedure.query((): never => {
        throw toTRPCError({ code: "ERR-EventNotFound" });
      }),
      notOwner: publicProcedure.mutation((): never => {
        throw toTRPCError({ code: "ERR-NotOwner" });
      }),
      ledgerUnavailable: publicProcedure.query((): never => {
        throw toTRPCError({ code: "ERR-LedgerUnavailable" });
      }),
      notASpecCode: publicProcedure.query((): never => {
        throw toTRPCError({ code: "connection refused by 10.0.0.7:5432" });
      }),
    }),
  }),
);

type TestRouter = typeof testRouter;

describe("tRPC error mapping", () => {
  let app: FastifyInstance;
  let client: ReturnType<typeof createTRPCClient<TestRouter>>;

  beforeAll(async () => {
    app = buildApp({}, testRouter);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    client = createTRPCClient<TestRouter>({
      links: [httpBatchLink({ url: `${address}${TRPC_PREFIX}` })],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  async function failure(call: () => Promise<unknown>): Promise<TRPCClientError<TestRouter>> {
    try {
      await call();
    } catch (error) {
      if (error instanceof TRPCClientError) {
        return error as TRPCClientError<TestRouter>;
      }
      throw error;
    }
    throw new Error("expected the call to fail");
  }

  it("REQ-Q-3: a sample procedure returns ERR-EventNotFound verbatim to a test client", async () => {
    const error = await failure(() => client.sample.eventNotFound.query());

    expect(error.data?.errorCode).toBe("ERR-EventNotFound");
    expect(error.message).toBe("ERR-EventNotFound");
    expect(error.data?.httpStatus).toBe(404);
  });

  it("REQ-Q-3: carries the §10 code verbatim from a mutation", async () => {
    const error = await failure(() => client.sample.notOwner.mutate());

    expect(error.data?.errorCode).toBe("ERR-NotOwner");
    expect(error.data?.httpStatus).toBe(403);
  });

  it("REQ-Q-3: carries a retryable §10 code with no backend detail", async () => {
    const error = await failure(() => client.sample.ledgerUnavailable.query());

    expect(error.data?.errorCode).toBe("ERR-LedgerUnavailable");
    expect(error.message).toBe("ERR-LedgerUnavailable");
    expect(error.data?.httpStatus).toBe(503);
  });

  it("does not pass on a code that is not a §10 code", async () => {
    const error = await failure(() => client.sample.notASpecCode.query());

    expect(error.data?.errorCode).toBeNull();
    expect(error.data?.code).toBe("INTERNAL_SERVER_ERROR");
    expect(error.message).not.toContain("10.0.0.7");
  });

  it("serves the root router's procedures beside the samples", async () => {
    await expect(client.system.health.query()).resolves.toEqual({ status: "ok" });
  });
});
