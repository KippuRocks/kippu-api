import type {
  AppRouter,
  BeginCheckoutInput,
  Checkout,
  HandoffLink,
  HoldRefusal,
  SaifuHandoff,
  SaleInventory,
} from "@kippurocks/api";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

const url = "http://127.0.0.1:8080/v0/trpc";

/**
 * How Ichiba begins a checkout (`T-022-02`): with no session, it gets a Saifu
 * handoff to pass on, and waits for the checkout to be linked.
 */
export async function beginCheckout(input: BeginCheckoutInput): Promise<SaifuHandoff | null> {
  const ichiba = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url })] });
  const { checkout } = await ichiba.sales.checkout.begin.mutate(input);
  return checkout.account.state === "handoff" ? checkout.account.handoff : null;
}

/** How Saifu links the holder's account to the checkout it was handed, and gets the pairing code (`AD-19` A). */
export async function linkCheckout(
  holderToken: string,
  handoff: SaifuHandoff,
): Promise<HandoffLink> {
  const saifu = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url, headers: { authorization: `Bearer ${holderToken}` } })],
  });
  return saifu.sales.checkout.link.mutate({ handoffToken: handoff.handoffToken });
}

/** How Ichiba confirms, once the buyer says Saifu shows the same code (`T-022-11`). */
export async function confirmPairing(token: string): Promise<Checkout | null> {
  const ichiba = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url })] });
  const { account } = await ichiba.sales.checkout.get.query({ token });
  if (account.state !== "pairing") return null;
  return ichiba.sales.checkout.confirmLink.mutate({ token, pairingCode: account.pairingCode });
}

/** How Ichiba places the hold (`T-022-03`): a refusal is shown before any payment step. */
export async function holdCheckout(token: string): Promise<HoldRefusal | Checkout> {
  const ichiba = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url })] });
  const result = await ichiba.sales.checkout.hold.mutate({ token });
  return result.outcome === "held" ? result.checkout : result.reason;
}

/** How Ichiba reads what it can offer of an event, with no session (`T-022-10`). */
export async function inventory(event: string): Promise<SaleInventory> {
  const ichiba = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url })] });
  return ichiba.sales.inventory.query({ event });
}

/**
 * How Ichiba pays for a held checkout (`T-022-04`): it redirects the buyer to the
 * provider's hosted page, then reads the checkout until its sale is issued.
 */
export async function payAndWait(token: string, returnTo: string): Promise<string | null> {
  const ichiba = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url })] });
  const payment = await ichiba.sales.checkout.pay.mutate({
    token,
    successUrl: `${returnTo}/paid`,
    cancelUrl: `${returnTo}/cancelled`,
  });
  void payment.url;
  // "Your ticket is in Saifu" only once Kippu's copy shows it (NFR-11).
  const { sale, refund, ticketVisible } = await ichiba.sales.checkout.get.query({
    token,
    waitForTicketMs: 10_000,
  });
  if (sale?.status === "issued") return ticketVisible ? sale.ticket : null;
  return refund?.reason ?? null;
}
