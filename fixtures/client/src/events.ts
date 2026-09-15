import type { AppRouter, InvitationRefusal, SaleAsset } from "@kippu/api";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";

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

/** How Ibento uploads a seated zone's canonical positions (`T-021-03`). */
export async function uploadSeatMap(
  token: string,
  event: string,
  zone: string,
  positions: readonly string[],
): Promise<readonly string[]> {
  const uploaded = await organiserClient(token).events.zones.addSeatPositions.mutate({
    event,
    zone,
    positions,
  });
  return uploaded.positions;
}

/** How Ibento issues a guest a seat from a granted class (`T-021-05`). */
export async function issueGuestSeat(
  token: string,
  input: { event: string; class: string; zone: string; position: string; holder: string },
): Promise<string> {
  const { ticket } = await organiserClient(token).events.tickets.issueGranted.mutate({
    event: input.event,
    class: input.class,
    zone: input.zone,
    placement: { kind: "Seated", position: input.position },
    holder: input.holder,
  });
  return ticket;
}

/** How Ibento prices a sale (`T-021-14`): the event's asset, then a Purchased class in its minor units. */
export async function priceStalls(token: string, event: string): Promise<SaleAsset | null> {
  const client = organiserClient(token);
  const { asset } = await client.events.setSaleAsset.mutate({ event, asset: "COPM/2" });
  const stalls = await client.events.classes.define.mutate({
    event,
    name: "Stalls",
    description: null,
    provenance: "Purchased",
    policy: { kind: "Single" },
    restrictions: { cannotResale: false, cannotTransfer: false },
    quota: null,
    price: 25_000,
  });
  await client.events.classes.setPrice.mutate({ event, class: stalls.id, price: 30_000 });
  return asset;
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

/** How Ibento invites a guest (`T-021-12`): the token is shown once, for the guest's link. */
export async function inviteGuest(
  token: string,
  input: { event: string; class: string; zone: string; guest: string | null },
): Promise<string> {
  const created = await organiserClient(token).events.invitations.create.mutate({
    ...input,
    placement: { kind: "Unseated" },
  });
  return created.token;
}

/** How Saifu redeems an invitation in a holder session: it receives the ticket's id. */
export async function redeemInvitation(holderToken: string, invitation: string): Promise<string> {
  const { ticket } = await organiserClient(holderToken).events.invitations.redeem.mutate({
    token: invitation,
  });
  return ticket;
}

/** Why Saifu's redemption was refused, typed from the router's error shape: a platform reason. */
export function redemptionRefusal(error: unknown): InvitationRefusal | null {
  if (error instanceof TRPCClientError) {
    const typed = error as TRPCClientError<AppRouter>;
    return (typed.data?.reason ?? null) as InvitationRefusal | null;
  }
  return null;
}
