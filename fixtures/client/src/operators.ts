import type {
  AdmissionSubmission,
  AppRouter,
  CheckRefusal,
  EnrolmentCode,
  GrantInput,
  OperatorAccount,
  OperatorGrant,
  OperatorRefusal,
} from "@kippu/api";
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

/** How Ibento grants an operator gates of an event for a window, and revokes it (`T-024-02`). */
export async function grantThenRevoke(token: string, input: GrantInput): Promise<OperatorGrant> {
  const api = signedIn(token);
  const grant = await api.operators.grants.create.mutate(input);
  return api.operators.grants.revoke.mutate({ grant: grant.id });
}

/** How Iriguchi offers an operator the events and gates they may choose. */
export async function gatesToChoose(operatorToken: string): Promise<[string, string][]> {
  const grants = await signedIn(operatorToken).operators.grants.mine.query();
  return grants.flatMap((grant) =>
    grant.gates.map((gate): [string, string] => [grant.event, gate]),
  );
}

/**
 * How Iriguchi checks the operator's authorisation alongside validating a pass
 * (`T-024-03`, `AC-E5.2`): authorised, or the reason it may not admit.
 */
export async function mayAdmit(
  operatorToken: string,
  event: string,
  gate: string,
): Promise<
  { authorised: true; drift: number } | { authorised: false; reason: CheckRefusal | null }
> {
  try {
    const { checkedAt } = await signedIn(operatorToken).operators.check.query({ event, gate });
    return { authorised: true, drift: Date.now() - checkedAt };
  } catch (error) {
    if (error instanceof TRPCClientError) {
      const reason = (error as TRPCClientError<AppRouter>).data?.reason ?? null;
      return { authorised: false, reason: reason as CheckRefusal | null };
    }
    throw error;
  }
}

/**
 * How Iriguchi reports an admission once its submission has ended (`T-024-04`,
 * `REQ-OP-3`). The report id is its own, so a retry is recorded once.
 */
export async function reportAdmission(
  operatorToken: string,
  scan: { reportId: string; event: string; gate: string; ticket: string; passId: string },
  presentedAt: number,
  submission: AdmissionSubmission,
): Promise<number> {
  const { receivedAt } = await signedIn(operatorToken).operators.reportAdmission.mutate({
    ...scan,
    verdict: { kind: "admitted", submission },
    presentedAt,
    deviceClock: Date.now(),
  });
  return receivedAt;
}

/** The reason an operator request was refused, typed from the router's error shape. */
export function operatorRefusal(error: unknown): OperatorRefusal | null {
  if (error instanceof TRPCClientError) {
    const reason = (error as TRPCClientError<AppRouter>).data?.reason;
    return reason === "unknown-operator" ||
      reason === "unknown-grant" ||
      reason === "not-granted" ||
      reason === "report-exists"
      ? reason
      : null;
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
  const window = { operator: "", event: "", gates: [], until: 0 };
  // @ts-expect-error — a grant's window is Unix milliseconds, not ISO text.
  await api.operators.grants.create.mutate({ ...window, from: new Date().toISOString() });
}
