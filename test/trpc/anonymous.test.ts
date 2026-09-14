import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { buildApp, TRPC_PREFIX } from "../../src/app.js";
import { ANONYMOUS, type Services } from "../../src/auth/ports.js";
import type { Context } from "../../src/trpc/context.js";
import { appRouter } from "../../src/trpc/router.js";
import { createCallerFactory, publicProcedure, router } from "../../src/trpc/trpc.js";

/**
 * The procedures the anonymous principal may reach. Adding a public procedure
 * means adding it here, where a reviewer sees it.
 */
const PUBLIC_PROCEDURES = [
  "auth.holder.beginLink",
  "auth.holder.completeLink",
  "auth.operator.redeemEnrolmentCode",
  "auth.organiser.beginSignIn",
  "auth.organiser.beginSignUp",
  "auth.organiser.completeSignIn",
  "auth.organiser.completeSignUp",
  "system.health",
];

function refusing(): never {
  throw new Error("no service may be reached in this test");
}

const services: Services = {
  auth: {
    beginOrganiserSignUp: refusing,
    completeOrganiserSignUp: refusing,
    beginOrganiserSignIn: refusing,
    completeOrganiserSignIn: refusing,
    redeemOperatorEnrolmentCode: refusing,
    beginHolderLink: refusing,
    completeHolderLink: refusing,
    authenticate: refusing,
    signOut: refusing,
  },
  events: new Proxy({} as Services["events"], { get: () => refusing }),
};

const anonymous: Context = { requestId: "test", session: null, principal: ANONYMOUS, services };

type Callable = (input?: unknown) => Promise<unknown>;

function callerAt(caller: unknown, path: string): Callable {
  let node = caller as Record<string, unknown>;
  for (const segment of path.split(".")) {
    node = node[segment] as Record<string, unknown>;
  }
  return node as unknown as Callable;
}

async function outcome(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "OK";
  } catch (error) {
    if (error instanceof TRPCError) {
      return error.code;
    }
    return "THREW";
  }
}

const procedurePaths = (r: { _def: { procedures: object } }) =>
  Object.keys(r._def.procedures).sort();

describe("the anonymous principal", () => {
  it("REQ-MP-7: reaches every public procedure", async () => {
    const caller = createCallerFactory(appRouter)(anonymous);
    const publicPaths = procedurePaths(appRouter).filter((path) =>
      PUBLIC_PROCEDURES.includes(path),
    );
    expect(publicPaths).toEqual(PUBLIC_PROCEDURES);

    await expect(caller.system.health()).resolves.toEqual({ status: "ok" });
    for (const path of publicPaths) {
      // Called with no input: a public procedure gets as far as validating it.
      expect([path, await outcome(() => callerAt(caller, path)())]).not.toEqual([
        path,
        "UNAUTHORIZED",
      ]);
    }
  });

  it("is refused by every other procedure in the root router", async () => {
    const caller = createCallerFactory(appRouter)(anonymous);
    const others = procedurePaths(appRouter).filter((path) => !PUBLIC_PROCEDURES.includes(path));
    expect(others.length).toBeGreaterThan(0);

    for (const path of others) {
      expect([path, await outcome(() => callerAt(caller, path)({}))]).toEqual([
        path,
        "UNAUTHORIZED",
      ]);
    }
  });

  it("is refused by a procedure whose access is left undeclared", async () => {
    const undeclared = router({
      probe: publicProcedure.meta({ access: undefined }).query(() => "reached"),
    });

    expect(await outcome(() => createCallerFactory(undeclared)(anonymous).probe())).toBe(
      "UNAUTHORIZED",
    );
  });

  it("is who a call with no bearer token acts as, over HTTP", async () => {
    const app = buildApp({}, appRouter, services);
    try {
      const health = await app.inject({ method: "GET", url: `${TRPC_PREFIX}/system.health` });
      expect(health.statusCode).toBe(200);

      const current = await app.inject({
        method: "GET",
        url: `${TRPC_PREFIX}/auth.session.current`,
      });
      expect(current.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
