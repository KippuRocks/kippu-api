import type { AppRouter, EnrolmentCode, OperatorAccount, OperatorRefusal } from "@kippu/api";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";

function signedIn(token: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "http://127.0.0.1:8080/v0/trpc",
        headers: { authorization: `Bearer ${token}` },
      }),
    ],
  });
}

/** How Ibento creates an operator and hands their device a one-time enrolment code (`T-024-01`). */
export async function enrolOperator(
  token: string,
  name: string,
): Promise<{ operator: OperatorAccount; enrolment: EnrolmentCode }> {
  const api = signedIn(token);
  const operator = await api.operators.create.mutate({ name });
  const enrolment = await api.operators.issueEnrolmentCode.mutate({ operator: operator.id });
  return { operator, enrolment };
}

/** How Iriguchi redeems the code for an operator session. */
export async function redeem(code: string): Promise<string> {
  const anonymous = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: "http://127.0.0.1:8080/v0/trpc" })],
  });
  const { session } = await anonymous.auth.operator.redeemEnrolmentCode.mutate({ code });
  return session.token;
}

/** How Ibento revokes every session of an operator at once. */
export async function revokeSessions(token: string, operator: string): Promise<number> {
  const { sessionsRevoked } = await signedIn(token).operators.revokeSessions.mutate({ operator });
  return sessionsRevoked;
}

/** The reason an operator request was refused, typed from the router's error shape. */
export function operatorRefusal(error: unknown): OperatorRefusal | null {
  if (error instanceof TRPCClientError) {
    const reason = (error as TRPCClientError<AppRouter>).data?.reason;
    return reason === "unknown-operator" ? reason : null;
  }
  return null;
}

/** Never called: the operator procedures' types are checked. */
export async function rejectedByTheCompiler(token: string): Promise<void> {
  const api = signedIn(token);
  // @ts-expect-error — an operator is created with a name.
  await api.operators.create.mutate({});
  // @ts-expect-error — the listing's session count is a number.
  const count: string = (await api.operators.list.query())[0]?.liveSessions ?? "";
  void count;
}
