import type { AppRouter } from "@kippu/api";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

/**
 * How Ibento signs an organiser in: an explicit WebAuthn exchange. The browser
 * side (`navigator.credentials`) is passed in, so the fixture compiles without
 * a WebAuthn helper library.
 */
type Api = ReturnType<typeof createTRPCClient<AppRouter>>;
type SignInChallenge = Awaited<ReturnType<Api["auth"]["organiser"]["beginSignIn"]["mutate"]>>;
type Assertion = Parameters<Api["auth"]["organiser"]["completeSignIn"]["mutate"]>[0]["credential"];

export async function signIn(
  email: string,
  getAssertion: (options: SignInChallenge["options"]) => Promise<Assertion>,
): Promise<{ token: string; expiresAt: string }> {
  const anonymous = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: "http://127.0.0.1:8080/v0/trpc" })],
  });
  const challenge = await anonymous.auth.organiser.beginSignIn.mutate({ email });
  const { session } = await anonymous.auth.organiser.completeSignIn.mutate({
    ceremonyId: challenge.ceremonyId,
    credential: await getAssertion(challenge.options),
  });
  return session;
}

/** A signed-in client sends the session token as a bearer token. */
export async function whoAmI(token: string): Promise<"organiser" | "operator"> {
  const signedIn = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "http://127.0.0.1:8080/v0/trpc",
        headers: { authorization: `Bearer ${token}` },
      }),
    ],
  });
  const { principal } = await signedIn.auth.session.current.query();
  return principal.kind;
}

/** Never called: the exchange's types are checked, not loosened to `any`. */
export async function rejectedByTheCompiler(api: Api): Promise<void> {
  // @ts-expect-error — completing sign-in needs the ceremony id.
  await api.auth.organiser.completeSignIn.mutate({ credential: {} });

  const challenge = await api.auth.organiser.beginSignUp.mutate({ email: "a@b.c" });
  // @ts-expect-error — the challenge is base64url text, not bytes.
  const bytes: Uint8Array = challenge.options.challenge;
  void bytes;

  // @ts-expect-error — an operator redeems a code, not an email.
  await api.auth.operator.redeemEnrolmentCode.mutate({ email: "a@b.c" });
}
