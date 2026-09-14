import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, publicProcedure, router } from "../trpc/trpc.js";
import {
  AuthError,
  type AuthFailure,
  type OperatorSession,
  type OrganiserSession,
  type SessionInfo,
  type SignInChallenge,
  type SignUpChallenge,
} from "./ports.js";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "./webauthn-json.js";

/**
 * Validates with a schema, and types the input as `T` — a type declared without
 * imports, so the published router type never refers to the validator.
 */
function parser<T>(schema: z.ZodType): (value: unknown) => T {
  return (value) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new TRPCError({ code: "BAD_REQUEST", message: z.prettifyError(result.error) });
    }
    return result.data as T;
  };
}

const base64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]*$/)
  .max(16_384);
const id = z.uuid();
const email = z.string().min(3).max(320);
const extensions = z.record(z.string(), z.unknown());
const attachment = z.enum(["cross-platform", "platform"]).optional();

const registrationResponse = z.object({
  id: base64url,
  rawId: base64url,
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: base64url,
    attestationObject: base64url,
    authenticatorData: base64url.optional(),
    transports: z.array(z.string().max(32)).max(16).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64url.optional(),
  }),
  authenticatorAttachment: attachment,
  clientExtensionResults: extensions,
});

const authenticationResponse = z.object({
  id: base64url,
  rawId: base64url,
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: base64url,
    authenticatorData: base64url,
    signature: base64url,
    userHandle: base64url.optional(),
  }),
  authenticatorAttachment: attachment,
  clientExtensionResults: extensions,
});

export interface EmailInput {
  readonly email: string;
}

export interface CompleteSignUpInput {
  readonly ceremonyId: string;
  readonly credential: RegistrationResponseJSON;
}

export interface CompleteSignInInput {
  readonly ceremonyId: string;
  readonly credential: AuthenticationResponseJSON;
}

export interface RedeemEnrolmentCodeInput {
  readonly code: string;
}

const TRANSPORT_CODE: Record<AuthFailure, TRPCError["code"]> = {
  "email-taken": "CONFLICT",
  "unknown-organiser": "NOT_FOUND",
  "ceremony-expired": "UNAUTHORIZED",
  "credential-rejected": "UNAUTHORIZED",
  "enrolment-code-rejected": "UNAUTHORIZED",
  "invalid-input": "BAD_REQUEST",
};

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AuthError) {
      throw new TRPCError({ code: TRANSPORT_CODE[error.failure], message: error.message });
    }
    throw error;
  }
}

/**
 * Organiser sign-up and sign-in are explicit WebAuthn exchanges: `begin*`
 * returns a challenge and the options for `navigator.credentials`; `complete*`
 * takes the credential the authenticator produced and returns a session. The
 * session's token is a bearer token for the `Authorization` header.
 */
const organiserRouter = router({
  beginSignUp: publicProcedure
    .input(parser<EmailInput>(z.object({ email })))
    .mutation(
      ({ ctx, input }): Promise<SignUpChallenge> =>
        mapped(() => ctx.services.auth.beginOrganiserSignUp(input.email)),
    ),
  completeSignUp: publicProcedure
    .input(
      parser<CompleteSignUpInput>(z.object({ ceremonyId: id, credential: registrationResponse })),
    )
    .mutation(
      ({ ctx, input }): Promise<OrganiserSession> =>
        mapped(() => ctx.services.auth.completeOrganiserSignUp(input.ceremonyId, input.credential)),
    ),
  beginSignIn: publicProcedure
    .input(parser<EmailInput>(z.object({ email })))
    .mutation(
      ({ ctx, input }): Promise<SignInChallenge> =>
        mapped(() => ctx.services.auth.beginOrganiserSignIn(input.email)),
    ),
  completeSignIn: publicProcedure
    .input(
      parser<CompleteSignInInput>(z.object({ ceremonyId: id, credential: authenticationResponse })),
    )
    .mutation(
      ({ ctx, input }): Promise<OrganiserSession> =>
        mapped(() => ctx.services.auth.completeOrganiserSignIn(input.ceremonyId, input.credential)),
    ),
});

/** Iriguchi redeems the one-time code an organiser issued (`F-024`) for a session. */
const operatorRouter = router({
  redeemEnrolmentCode: publicProcedure
    .input(parser<RedeemEnrolmentCodeInput>(z.object({ code: z.string().min(1).max(256) })))
    .mutation(
      ({ ctx, input }): Promise<OperatorSession> =>
        mapped(() => ctx.services.auth.redeemOperatorEnrolmentCode(input.code)),
    ),
});

const sessionRouter = router({
  current: authenticatedProcedure.query(({ ctx }): SessionInfo => ctx.session),
  signOut: authenticatedProcedure.mutation(async ({ ctx }): Promise<{ signedOut: true }> => {
    await ctx.services.auth.signOut(ctx.session.principal.sessionId);
    return { signedOut: true };
  }),
});

export const authRouter = router({
  organiser: organiserRouter,
  operator: operatorRouter,
  session: sessionRouter,
});
