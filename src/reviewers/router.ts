import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticationResponse, registrationResponse } from "../auth/router.js";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "../auth/webauthn-json.js";
import { reviewerCapacityProofsRouter } from "../proofs/router.js";
import { publicProcedure, router } from "../trpc/trpc.js";
import {
  ReviewerAuthError,
  type ReviewerAuthFailure,
  type ReviewerEnrolmentChallenge,
  type ReviewerSession,
  type ReviewerSignInChallenge,
} from "./ports.js";

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

export interface BeginReviewerEnrolmentInput {
  /** The one-time enrolment code the command line issued. */
  readonly code: string;
  /** The email the reviewer was created with. */
  readonly email: string;
}

export interface CompleteReviewerEnrolmentInput {
  readonly ceremonyId: string;
  readonly credential: RegistrationResponseJSON;
}

export interface ReviewerEmailInput {
  readonly email: string;
}

export interface CompleteReviewerSignInInput {
  readonly ceremonyId: string;
  readonly credential: AuthenticationResponseJSON;
}

const TRANSPORT_CODE: Record<ReviewerAuthFailure, TRPCError["code"]> = {
  "enrolment-code-rejected": "UNAUTHORIZED",
  "unknown-reviewer": "NOT_FOUND",
  "ceremony-expired": "UNAUTHORIZED",
  "credential-rejected": "UNAUTHORIZED",
  "invalid-input": "BAD_REQUEST",
};

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ReviewerAuthError) {
      throw new TRPCError({ code: TRANSPORT_CODE[error.failure], message: error.message });
    }
    throw error;
  }
}

const id = z.uuid();
const email = z.string().min(3).max(320);
const code = z.string().min(1).max(256);

/**
 * Kippu operations reviewers' enrolment and sign-in (`T-021-16`; `F-021` plan
 * §5.4). There is no procedure to create or disable a reviewer: that is the
 * deployment's command line (`pnpm reviewer:create`, `pnpm reviewer:disable`).
 * Enrolment redeems the one-time code with the reviewer's email and a passkey on
 * Kippu's login RP id; sign-in uses that passkey. Each opens a 12-hour reviewer
 * session, sent as a bearer token like any other. A reviewer session reaches
 * reviewer procedures only, and an organiser session never does: the capacity
 * proof review queue (`capacityProofs`, `T-021-08`).
 */
export const reviewersRouter = router({
  enrolment: router({
    begin: publicProcedure
      .input(parser<BeginReviewerEnrolmentInput>(z.object({ code, email }).strict()))
      .mutation(
        ({ ctx, input }): Promise<ReviewerEnrolmentChallenge> =>
          mapped(() => ctx.services.reviewers.beginEnrolment(input.code, input.email)),
      ),
    complete: publicProcedure
      .input(
        parser<CompleteReviewerEnrolmentInput>(
          z.object({ ceremonyId: id, credential: registrationResponse }),
        ),
      )
      .mutation(
        ({ ctx, input }): Promise<ReviewerSession> =>
          mapped(() =>
            ctx.services.reviewers.completeEnrolment(input.ceremonyId, input.credential),
          ),
      ),
  }),
  signIn: router({
    begin: publicProcedure
      .input(parser<ReviewerEmailInput>(z.object({ email }).strict()))
      .mutation(
        ({ ctx, input }): Promise<ReviewerSignInChallenge> =>
          mapped(() => ctx.services.reviewers.beginSignIn(input.email)),
      ),
    complete: publicProcedure
      .input(
        parser<CompleteReviewerSignInInput>(
          z.object({ ceremonyId: id, credential: authenticationResponse }),
        ),
      )
      .mutation(
        ({ ctx, input }): Promise<ReviewerSession> =>
          mapped(() => ctx.services.reviewers.completeSignIn(input.ceremonyId, input.credential)),
      ),
  }),
  capacityProofs: reviewerCapacityProofsRouter,
});
