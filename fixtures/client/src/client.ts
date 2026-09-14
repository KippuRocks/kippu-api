import type { AppRouter } from "@kippu/api";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";

const client = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "http://127.0.0.1:8080/v0/trpc" })],
});

/** A typed call: the output type comes from the published router type. */
export async function health(): Promise<"ok"> {
  const { status } = await client.system.health.query();
  return status;
}

/** The `SPEC.md` §10 code a failed call carries, typed from the router's error shape. */
export function reason(error: unknown): string | null {
  if (error instanceof TRPCClientError) {
    const typed = error as TRPCClientError<AppRouter>;
    return typed.data?.errorCode ?? null;
  }
  return null;
}

/** Never called: proves the router type rejects calls it does not describe. */
export async function rejectedByTheCompiler(): Promise<void> {
  // @ts-expect-error — no such procedure in the router.
  await client.system.unknownProcedure.query();

  // @ts-expect-error — the output is `{ status: "ok" }`, not a number.
  const status: number = (await client.system.health.query()).status;
  void status;
}
