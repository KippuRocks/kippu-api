import type { AppRouter } from "@kippu/api";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

function organiserClient(token: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "http://127.0.0.1:8080/v0/trpc",
        headers: { authorization: `Bearer ${token}` },
      }),
    ],
  });
}

/** How Ibento creates an event (`T-021-02`): it gets the event's id and the receipt's cursor. */
export async function createEvent(
  token: string,
  zone: string,
): Promise<{ event: string; cursor: string }> {
  return organiserClient(token).events.create.mutate({
    zones: [{ id: zone, kind: "Seated" }],
    capacity: 500,
  });
}

/** How Ibento defines a guest class (`T-021-04`): the router types the class it returns. */
export async function definePressClass(token: string, event: string): Promise<string> {
  const defined = await organiserClient(token).events.classes.define.mutate({
    event,
    name: "Press",
    description: null,
    provenance: "Granted",
    policy: { kind: "Single" },
    restrictions: { cannotResale: true, cannotTransfer: true },
    quota: 20,
  });
  return defined.id;
}

/** Never called: the router type refuses a class definition it does not describe. */
export async function classRejectedByTheCompiler(token: string, event: string): Promise<void> {
  await organiserClient(token).events.classes.define.mutate({
    event,
    name: "Press",
    description: null,
    // @ts-expect-error — provenance is `Purchased` or `Granted`.
    provenance: "Complimentary",
    policy: { kind: "Single" },
    restrictions: { cannotResale: false, cannotTransfer: false },
    quota: null,
  });
}
