import { afterAll, beforeAll, expect, it } from "vitest";
import { ENROLMENT_CODE_MS } from "../../src/operators/service.js";
import { describeWithStore } from "../support/database.js";
import { type OperatorHarness, operatorHarness, refused } from "../support/operator-harness.js";

describeWithStore("operator accounts", () => {
  let harness: OperatorHarness;

  beforeAll(async () => {
    harness = await operatorHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("US-E5, REQ-OP-1: an organiser creates an operator who can sign in", async () => {
    const organiser = await harness.organiser();

    const operator = await organiser.client.operators.create.mutate({ name: "Gate staff 1" });
    expect(operator).toMatchObject({ name: "Gate staff 1", liveSessions: 0 });

    const { code, expiresAt } = await organiser.client.operators.issueEnrolmentCode.mutate({
      operator: operator.id,
    });
    expect(expiresAt).toBe(new Date(harness.now().getTime() + ENROLMENT_CODE_MS).toISOString());

    const redeemed = await harness.client().auth.operator.redeemEnrolmentCode.mutate({ code });
    expect(redeemed.operator).toEqual({ id: operator.id, organiserId: organiser.organiserId });

    const current = await harness.client(redeemed.session.token).auth.session.current.query();
    expect(current.principal).toMatchObject({
      kind: "operator",
      operatorId: operator.id,
      organiserId: organiser.organiserId,
    });
    expect(await organiser.client.operators.list.query()).toEqual([
      { ...operator, liveSessions: 1 },
    ]);
  });

  it("an organiser's operators are theirs alone", async () => {
    const owner = await harness.organiser();
    const other = await harness.organiser();
    const operator = await owner.client.operators.create.mutate({ name: "Door A" });

    expect(await other.client.operators.list.query()).toEqual([]);
    expect(
      await refused(() =>
        other.client.operators.issueEnrolmentCode.mutate({ operator: operator.id }),
      ),
    ).toEqual({ code: "NOT_FOUND", reason: "unknown-operator" });
    expect(
      await refused(() => other.client.operators.revokeSessions.mutate({ operator: operator.id })),
    ).toEqual({ code: "NOT_FOUND", reason: "unknown-operator" });
  });

  it("an enrolment code opens one session, and none once it has expired", async () => {
    const organiser = await harness.organiser();
    const operator = await organiser.client.operators.create.mutate({ name: "Door B" });

    const once = await organiser.client.operators.issueEnrolmentCode.mutate({
      operator: operator.id,
    });
    await harness.client().auth.operator.redeemEnrolmentCode.mutate({ code: once.code });
    expect(
      await refused(() =>
        harness.client().auth.operator.redeemEnrolmentCode.mutate({ code: once.code }),
      ),
    ).toMatchObject({ code: "UNAUTHORIZED" });

    const stale = await organiser.client.operators.issueEnrolmentCode.mutate({
      operator: operator.id,
    });
    harness.advance(ENROLMENT_CODE_MS);
    expect(
      await refused(() =>
        harness.client().auth.operator.redeemEnrolmentCode.mutate({ code: stale.code }),
      ),
    ).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("revoking an operator's sessions ends every one at once, and voids their unredeemed codes", async () => {
    const organiser = await harness.organiser();
    const operator = await organiser.client.operators.create.mutate({ name: "Door C" });
    const issue = () =>
      organiser.client.operators.issueEnrolmentCode.mutate({ operator: operator.id });
    const redeem = (code: string) =>
      harness.client().auth.operator.redeemEnrolmentCode.mutate({ code });

    const phone = await redeem((await issue()).code);
    const tablet = await redeem((await issue()).code);
    const unredeemed = await issue();

    expect(
      await organiser.client.operators.revokeSessions.mutate({ operator: operator.id }),
    ).toEqual({ operator: operator.id, sessionsRevoked: 2, codesVoided: 1 });
    for (const { session } of [phone, tablet]) {
      expect(
        await refused(() => harness.client(session.token).auth.session.current.query()),
      ).toMatchObject({ code: "UNAUTHORIZED" });
    }
    expect(await refused(() => redeem(unredeemed.code))).toMatchObject({ code: "UNAUTHORIZED" });
    expect((await organiser.client.operators.list.query())[0]?.liveSessions).toBe(0);

    // A code issued after the revocation enrols the operator again.
    const again = await redeem((await issue()).code);
    await expect(
      harness.client(again.session.token).auth.session.current.query(),
    ).resolves.toMatchObject({ principal: { kind: "operator", operatorId: operator.id } });
  });

  it("only an organiser administers operators", async () => {
    const organiser = await harness.organiser();
    const operator = await organiser.client.operators.create.mutate({ name: "Door D" });
    const { code } = await organiser.client.operators.issueEnrolmentCode.mutate({
      operator: operator.id,
    });
    const { session } = await harness.client().auth.operator.redeemEnrolmentCode.mutate({ code });
    const signedIn = harness.client(session.token);

    expect(await refused(() => signedIn.operators.create.mutate({ name: "Myself" }))).toMatchObject(
      {
        code: "FORBIDDEN",
      },
    );
    expect(
      await refused(() => signedIn.operators.issueEnrolmentCode.mutate({ operator: operator.id })),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(await refused(() => harness.client().operators.list.query())).toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("an operator's name is required, and at most 200 characters", async () => {
    const organiser = await harness.organiser();

    for (const name of ["", "   ", "x".repeat(201)]) {
      expect(await refused(() => organiser.client.operators.create.mutate({ name }))).toMatchObject(
        { code: "BAD_REQUEST" },
      );
    }
  });
});
