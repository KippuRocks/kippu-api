import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AdmissionReportInput } from "../../src/operators/ports.js";
import { type AdmissionReports, createAdmissionReports } from "../../src/operators/reports.js";
import { describeWithStore } from "../support/database.js";
import {
  type Client,
  type OperatorHarness,
  operatorHarness,
  refused,
} from "../support/operator-harness.js";

const HOUR = 60 * 60 * 1000;
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

describeWithStore("admission reports", () => {
  let harness: OperatorHarness;
  /** What F-025 reads, over the same store. */
  let reports: AdmissionReports;

  beforeAll(async () => {
    harness = await operatorHarness();
    reports = createAdmissionReports({ store: harness.database.store });
  });

  afterAll(async () => {
    await harness.close();
  });

  interface Gate {
    readonly organiser: Client;
    readonly event: string;
    readonly operator: string;
    readonly device: Client;
    readonly grant: string;
  }

  /** An operator signed in on a device, granted `gates` of `event`. */
  async function gate(
    organiser: { organiserId: string; client: Client },
    event: string,
    gates: string[] = ["North door"],
  ): Promise<Gate> {
    const { client } = organiser;
    const { id: operator } = await client.operators.create.mutate({ name: "Gate staff" });
    const { code } = await client.operators.issueEnrolmentCode.mutate({ operator });
    const { session } = await harness.client().auth.operator.redeemEnrolmentCode.mutate({ code });
    const from = harness.now().getTime();
    const { id: grant } = await client.operators.grants.create.mutate({
      operator,
      event,
      gates,
      from,
      until: from + 4 * HOUR,
    });
    return { organiser: client, event, operator, device: harness.client(session.token), grant };
  }

  async function venue() {
    const organiser = await harness.organiser();
    const event = await harness.createEvent(organiser.organiserId);
    return { organiser, event };
  }

  const admitted = (
    event: string,
    overrides: Partial<AdmissionReportInput> = {},
  ): AdmissionReportInput => ({
    reportId: randomUUID(),
    event,
    gate: "North door",
    ticket: hex(32),
    passId: hex(16),
    verdict: { kind: "admitted", submission: { outcome: "settled", cursor: "42" } },
    presentedAt: harness.now().getTime() - 1500,
    deviceClock: harness.now().getTime() + 12_000,
    ...overrides,
  });

  it("REQ-OP-3: reports are stored and queryable by F-025", async () => {
    const { organiser, event } = await venue();
    const north = await gate(organiser, event, ["North door"]);
    const south = await gate(organiser, event, ["South door"]);
    const ticket = hex(32);
    const passId = hex(16);

    // The same pass admitted at two gates: the ledger records one and refuses the other.
    const holder = hex(32);
    const first = admitted(event, { ticket, passId, holder });
    const second = admitted(event, {
      gate: "South door",
      ticket,
      passId,
      verdict: {
        kind: "admitted",
        submission: { outcome: "rejected", errorCode: "ERR-PassReplayed" },
      },
    });
    const refusal = admitted(event, {
      verdict: { kind: "refused", reason: "ERR-PassExpired" },
    });
    const failed = admitted(event, {
      verdict: { kind: "admitted", submission: { outcome: "failed" } },
    });

    const recorded = await north.device.operators.reportAdmission.mutate(first);
    expect(recorded).toEqual({
      ...first,
      operator: north.operator,
      receivedAt: harness.now().getTime(),
    });
    await south.device.operators.reportAdmission.mutate(second);
    await north.device.operators.reportAdmission.mutate(refusal);
    await north.device.operators.reportAdmission.mutate(failed);

    const forPass = await reports.list({ passId });
    expect(forPass.reports).toMatchObject([
      { ...first, operator: north.operator, organiserId: organiser.organiserId },
      { ...second, operator: south.operator, organiserId: organiser.organiserId },
    ]);
    // The gate's clock is kept beside Kippu's, so drift can be flagged (F-025 plan §5.5).
    const [stored] = forPass.reports;
    expect((stored?.deviceClock ?? 0) - (stored?.receivedAt ?? 0)).toBe(12_000);

    const forEvent = await reports.list({ event });
    expect(forEvent.reports.map((report) => report.reportId)).toEqual([
      first.reportId,
      second.reportId,
      refusal.reportId,
      failed.reportId,
    ]);
    expect(forEvent.reports[2]?.verdict).toEqual({ kind: "refused", reason: "ERR-PassExpired" });

    // Paging, in the order received.
    const page = await reports.list({ event, limit: 3 });
    expect(page.reports).toHaveLength(3);
    const rest = await reports.list({ event, after: page.next });
    expect(rest.reports.map((report) => report.reportId)).toEqual([failed.reportId]);
    expect(await reports.list({ event, after: rest.next })).toEqual({
      reports: [],
      next: rest.next,
    });
  });

  it("a report sent again is recorded once", async () => {
    const { organiser, event } = await venue();
    const north = await gate(organiser, event);
    const report = admitted(event);

    const once = await north.device.operators.reportAdmission.mutate(report);
    harness.advance(5_000);
    expect(await north.device.operators.reportAdmission.mutate(report)).toEqual(once);
    expect((await reports.list({ passId: report.passId })).reports).toHaveLength(1);
  });

  it("another operator's report id is refused", async () => {
    const { organiser, event } = await venue();
    const north = await gate(organiser, event);
    const south = await gate(organiser, event);
    const report = admitted(event);
    await north.device.operators.reportAdmission.mutate(report);

    expect(await refused(() => south.device.operators.reportAdmission.mutate(report))).toEqual({
      code: "CONFLICT",
      reason: "report-exists",
    });
  });

  it("an operator reports only at gates they were granted", async () => {
    const { organiser, event } = await venue();
    const other = await venue();
    const north = await gate(organiser, event);

    for (const report of [admitted(event, { gate: "West door" }), admitted(other.event)]) {
      expect(await refused(() => north.device.operators.reportAdmission.mutate(report))).toEqual({
        code: "FORBIDDEN",
        reason: "not-granted",
      });
    }
  });

  it("REQ-OP-3: an ended grant still accepts reports", async () => {
    const { organiser, event } = await venue();
    const north = await gate(organiser, event);

    const presentedAt = harness.now().getTime() + HOUR;
    harness.advance(5 * HOUR);
    await expect(
      north.device.operators.reportAdmission.mutate(admitted(event, { presentedAt })),
    ).resolves.toBeDefined();
  });

  it("REQ-OP-3: a revoked grant accepts reports of passes presented before its revocation, and no others", async () => {
    const { organiser, event } = await venue();
    const north = await gate(organiser, event);
    const before = harness.now().getTime();
    harness.advance(1_000);
    await organiser.client.operators.grants.revoke.mutate({ grant: north.grant });
    const revokedAt = harness.now().getTime();
    harness.advance(HOUR);

    await expect(
      north.device.operators.reportAdmission.mutate(admitted(event, { presentedAt: before })),
    ).resolves.toBeDefined();
    for (const presentedAt of [revokedAt, revokedAt + 1]) {
      expect(
        await refused(() =>
          north.device.operators.reportAdmission.mutate(admitted(event, { presentedAt })),
        ),
      ).toEqual({ code: "FORBIDDEN", reason: "grant-revoked" });
    }

    // A live grant for the gate covers what the revoked one no longer does.
    const from = harness.now().getTime();
    await organiser.client.operators.grants.create.mutate({
      operator: north.operator,
      event,
      gates: ["North door"],
      from,
      until: from + HOUR,
    });
    await expect(
      north.device.operators.reportAdmission.mutate(admitted(event, { presentedAt: from })),
    ).resolves.toBeDefined();
  });

  it("REQ-OP-3: a revoked session reports admissions presented before its revocation, for 24 hours, and does nothing else", async () => {
    const { organiser, event } = await venue();
    const north = await gate(organiser, event);
    const before = harness.now().getTime();
    harness.advance(1_000);
    await organiser.client.operators.revokeSessions.mutate({ operator: north.operator });
    const revokedAt = harness.now().getTime();
    harness.advance(HOUR);

    const report = admitted(event, { presentedAt: before });
    await expect(north.device.operators.reportAdmission.mutate(report)).resolves.toMatchObject({
      reportId: report.reportId,
      operator: north.operator,
    });
    const [stored] = (await reports.list({ passId: report.passId })).reports;
    expect(stored).toMatchObject({ operator: north.operator, organiserId: expect.any(String) });

    for (const presentedAt of [revokedAt, revokedAt + 1]) {
      expect(
        await refused(() =>
          north.device.operators.reportAdmission.mutate(admitted(event, { presentedAt })),
        ),
      ).toMatchObject({ code: "UNAUTHORIZED" });
    }
    // Everything else from the revoked session stays refused.
    for (const call of [
      () => north.device.operators.check.query({ event, gate: "North door" }),
      () => north.device.operators.grants.mine.query(),
      () => north.device.auth.session.current.query(),
    ]) {
      expect(await refused(call)).toMatchObject({ code: "UNAUTHORIZED" });
    }

    // 24 hours after the revocation, nothing at all.
    harness.advance(revokedAt + 24 * HOUR - harness.now().getTime());
    expect(
      await refused(() =>
        north.device.operators.reportAdmission.mutate(admitted(event, { presentedAt: before })),
      ),
    ).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("a report with no session, or an unknown token, is refused", async () => {
    const { event } = await venue();
    for (const client of [harness.client(), harness.client("x".repeat(43))]) {
      expect(
        await refused(() => client.operators.reportAdmission.mutate(admitted(event))),
      ).toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("a report names its outcome with a §10 code, and only an operator sends one", async () => {
    const { organiser, event } = await venue();
    const north = await gate(organiser, event);

    for (const overrides of [
      {
        verdict: {
          kind: "admitted",
          submission: { outcome: "rejected", errorCode: "replayed" },
        },
      },
      { verdict: { kind: "refused", reason: "" } },
      { passId: hex(32) },
      { reportId: "not-a-uuid" },
    ] as Partial<AdmissionReportInput>[]) {
      expect(
        await refused(() =>
          north.device.operators.reportAdmission.mutate(admitted(event, overrides)),
        ),
      ).toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(
      await refused(() => organiser.client.operators.reportAdmission.mutate(admitted(event))),
    ).toMatchObject({ code: "FORBIDDEN", reason: null });
  });
});
