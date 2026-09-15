import type {
  AppRouter,
  BeginCheckoutInput,
  Checkout,
  HoldRefusal,
  SaifuHandoff,
} from "@kippu/api";
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

/** How Saifu links the holder's account to the checkout it was handed (`AD-19` A). */
export async function linkCheckout(holderToken: string, handoff: SaifuHandoff): Promise<Checkout> {
  const saifu = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url, headers: { authorization: `Bearer ${holderToken}` } })],
  });
  return saifu.sales.checkout.link.mutate({ token: handoff.token });
}

/** How Ichiba places the hold (`T-022-03`): a refusal is shown before any payment step. */
export async function holdCheckout(token: string): Promise<HoldRefusal | Checkout> {
  const ichiba = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url })] });
  const result = await ichiba.sales.checkout.hold.mutate({ token });
  return result.outcome === "held" ? result.checkout : result.reason;
}
