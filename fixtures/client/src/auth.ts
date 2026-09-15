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
export async function whoAmI(
  token: string,
): Promise<"organiser" | "operator" | "holder" | "reviewer"> {
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

/**
 * The shape `@simplewebauthn/browser`'s `startAuthentication` and
 * `startRegistration` return: extension outputs are an interface of known
 * extensions, with no index signature. Ibento passes them straight through.
 */
interface BrowserExtensionOutputs {
  appid?: boolean;
  credProps?: { rk?: boolean };
  hmacCreateSecret?: boolean;
}
interface BrowserAuthenticationResponse {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  authenticatorAttachment?: "cross-platform" | "platform";
  clientExtensionResults: BrowserExtensionOutputs;
}
interface BrowserRegistrationResponse {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    attestationObject: string;
    authenticatorData?: string;
    transports?: ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[];
    publicKeyAlgorithm?: number;
    publicKey?: string;
  };
  authenticatorAttachment?: "cross-platform" | "platform";
  clientExtensionResults: BrowserExtensionOutputs;
}
type Attestation = Parameters<
  Api["auth"]["organiser"]["completeSignUp"]["mutate"]
>[0]["credential"];

/** Never called: a browser helper's responses are accepted as they come. */
export function acceptsBrowserResponses(
  assertion: BrowserAuthenticationResponse,
  attestation: BrowserRegistrationResponse,
): [Assertion, Attestation] {
  return [assertion, attestation];
}

/**
 * How Saifu links a holder account: a proof-of-control challenge, signed with
 * the holder credential through `@ticketto/profile-v0` (passed in here), then
 * exchanged for a holder session.
 */
type LinkChallenge = Awaited<ReturnType<Api["auth"]["holder"]["beginLink"]["mutate"]>>;

export async function linkHolder(
  api: Api,
  account: string,
  signProof: (challenge: LinkChallenge["challenge"]) => Promise<string>,
): Promise<{ account: string; token: string }> {
  const { challengeId, challenge } = await api.auth.holder.beginLink.mutate({ account });
  const { session, holder } = await api.auth.holder.completeLink.mutate({
    challengeId,
    authorisation: await signProof(challenge),
  });
  // @ts-expect-error — the challenge's expiry is milliseconds, not a string.
  const expiry: string = challenge.expiresAt;
  void expiry;
  return { account: holder.account, token: session.token };
}

/** How Ibento's review queue signs a Kippu reviewer in (`T-021-16`): a passkey on the login RP id. */
export async function reviewerSignIn(
  email: string,
  getAssertion: (
    options: Awaited<
      ReturnType<
        ReturnType<typeof createTRPCClient<AppRouter>>["reviewers"]["signIn"]["begin"]["mutate"]
      >
    >["options"],
  ) => Promise<Assertion>,
): Promise<{ token: string; expiresAt: string }> {
  const anonymous = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: "http://127.0.0.1:8080/v0/trpc" })],
  });
  const challenge = await anonymous.reviewers.signIn.begin.mutate({ email });
  const { session } = await anonymous.reviewers.signIn.complete.mutate({
    ceremonyId: challenge.ceremonyId,
    credential: await getAssertion(challenge.options),
  });
  return session;
}
