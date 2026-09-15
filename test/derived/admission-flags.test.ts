import { randomBytes, randomUUID } from "node:crypto";
import { producePass } from "@ticketto/profile-v0";
import { simulatedWebAuthnSigner } from "@ticketto/profile-v0/testing";
import type {
  AccountId,
  Authorisation,
  ClassId,
  Discriminator,
  OperationId,
  PassId,
  TicketId,
  ZoneId,
} from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Services } from "../../src/auth/ports.js";
import { GATE_CLOCK_TOLERANCE_MS } from "../../src/derived/admission-flags.js";
import { createFreshness, type Freshness } from "../../src/derived/freshness.js";
import { ledgerFactsProjection } from "../../src/derived/ledger-facts.js";
import type { AdmissionFlag } from "../../src/derived/ports.js";
import { createDerivedQueries } from "../../src/derived/queries.js";
import { createDerivedReader } from "../../src/derived/reader.js";
import { createReads } from "../../src/derived/reads.js";
import { ledgerLimits } from "../../src/ledger/rules.js";
import type { AdmissionReportInput } from "../../src/operators/ports.js";
import type { Context } from "../../src/trpc/context.js";
import { appRouter } from "../../src/trpc/router.js";
import { createCallerFactory } from "../../src/trpc/trpc.js";
import { describeWithStore } from "../support/database.js";
import { scriptedLog, wholeLog } from "../support/derived.js";
import { memoryMetadataStorage } from "../support/object-storage.js";
import {
  type Client,
  type OperatorHarness,
  operatorHarness,
  type SignedInOrganiser,
} from "../support/operator-harness.js";

const HOUR = 60 * 60 * 1000;
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

// These tests create databases and write to a ledger: on a loaded machine that
// takes far longer than Vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describeWithStore("provisional-admission flags", () => {
  let harness: OperatorHarness;
  let freshness: Freshness;
  let services: Services;

  beforeAll(async () => {
    harness = await operatorHarness();
    const store = harness.database.store;
    freshness = createFreshness({ store, pollInterval: 50 });
    services = {
      ...({} as Services),
      derived: createReads({
        store,
        freshness,
        storage: memoryMetadataStorage(),
        authority: harness.authority,
      }),
    };
  });

  afterAll(async () => {
    await freshness.close();
    await harness.close();
  });

  /** Ibento's read of the flags, as the organiser. */
  const flagsFor = async (organiser: SignedInOrganiser, event: string) => {
    const context: Context = {
      requestId: "test",
      session: {
        principal: { kind: "organiser", organiserId: organiser.organiserId, sessionId: "s" },
        expiresAt: new Date(Date.now() + HOUR).toISOString(),
      },
      principal: { kind: "organiser", organiserId: organiser.organiserId, sessionId: "s" },
      services,
    };
    return createCallerFactory(appRouter)(context).derived.admissionFlags.list({ event });
  };

  /** An operator signed in on a device, granted one gate of the event. */
  async function device(
    organiser: SignedInOrganiser,
    event: string,
    gate: string,
  ): Promise<Client> {
    const { client } = organiser;
    const { id: operator } = await client.operators.create.mutate({ name: gate });
    const { code } = await client.operators.issueEnrolmentCode.mutate({ operator });
    const { session } = await harness.client().auth.operator.redeemEnrolmentCode.mutate({ code });
    const from = harness.now().getTime();
    await client.operators.grants.create.mutate({
      operator,
      event,
      gates: [gate],
      from,
      until: from + 4 * HOUR,
    });
    return harness.client(session.token);
  }

  /** An event with one unseated zone, and a granted ticket in it, on backend-memory. */
  async function eventWithTicket(organiserId: string, holder = hex(32) as AccountId) {
    const request = {
      requestId: `req-${randomUUID()}`,
      principal: { kind: "organiser", organiserId, sessionId: randomUUID() },
    } as const;
    const zone = hex(32) as ZoneId;
    const created = await harness.authority.relay(organiserId, request, (signer) =>
      harness.ledger.createEvent(signer, {
        salt: randomBytes(32),
        zones: [{ id: zone, kind: "Unseated" }],
        capacity: null,
        metadata: null,
      }),
    );
    expect(await created.submission).toMatchObject({ ok: true });
    const issued = await harness.authority.relay(organiserId, request, (signer) =>
      harness.ledger.issueTicket(signer, {
        event: created.id,
        zone,
        placement: { kind: "Unseated", discriminator: hex(16) as Discriminator },
        class: hex(32) as ClassId,
        provenance: "Purchased",
        policy: { kind: "Single" },
        restrictions: { cannotResale: false, cannotTransfer: false },
        holder,
        metadata: null,
      }),
    );
    expect(await issued.submission).toMatchObject({ ok: true });
    return { event: created.id, ticket: issued.id, holder };
  }

  const report = (
    event: string,
    gate: string,
    overrides: Partial<AdmissionReportInput>,
  ): AdmissionReportInput => ({
    reportId: randomUUID(),
    event,
    gate,
    ticket: hex(32),
    passId: hex(16),
    verdict: { kind: "admitted", submission: { outcome: "settled", cursor: "1" } },
    presentedAt: harness.now().getTime() - 1500,
    // Within tolerance unless a case says otherwise.
    deviceClock: harness.now().getTime() + 2_000,
    ...overrides,
  });
  const rejected = (errorCode: string): AdmissionReportInput["verdict"] => ({
    kind: "admitted",
    submission: { outcome: "rejected", errorCode },
  });

  const byReport = (flags: readonly AdmissionFlag[], reportId: string) =>
    flags.find((flag) => flag.reportId === reportId);

  it("REQ-OP-3: each cause in §5.5 is flagged in a scripted scenario", async () => {
    const organiser = await harness.organiser();
    const { event, ticket, holder } = await eventWithTicket(organiser.organiserId);
    const north = await device(organiser, event, "North door");
    const south = await device(organiser, event, "South door");
    const now = harness.now().getTime();

    // The same pass admitted at two gates (AC-E3.4): the ledger records one, refuses the other.
    const passAtTwoGates = hex(16);
    const recorded = report(event, "North door", { ticket, passId: passAtTwoGates });
    const replayed = report(event, "South door", {
      ticket,
      passId: passAtTwoGates,
      verdict: rejected("ERR-PassReplayed"),
    });
    // A transfer away from the pass's holder, recorded after the pass was presented.
    const presentedBeforeTransfer = now - 1500;
    const transferAt = presentedBeforeTransfer + 500;
    const invalidAfterTransfer = report(event, "North door", {
      ticket,
      holder,
      presentedAt: presentedBeforeTransfer,
      verdict: rejected("ERR-InvalidPass"),
    });
    // The transfer's ledger time is 9 s before the claimed presentation: within the gate tolerance.
    const invalidWithinTolerance = report(event, "North door", {
      ticket,
      holder,
      presentedAt: transferAt + 9_000,
      verdict: rejected("ERR-InvalidPass"),
    });
    // Not explained by that transfer: presented more than 10 s after it was recorded; a
    // report carrying no holder; a pass of another holder than the one the ticket left.
    const invalidTransferTooEarly = report(event, "North door", {
      ticket,
      holder,
      presentedAt: transferAt + GATE_CLOCK_TOLERANCE_MS + 1,
      verdict: rejected("ERR-InvalidPass"),
    });
    const invalidWithoutHolder = report(event, "North door", {
      ticket,
      presentedAt: presentedBeforeTransfer,
      verdict: rejected("ERR-InvalidPass"),
    });
    const invalidOtherHolder = report(event, "North door", {
      ticket,
      holder: hex(32),
      presentedAt: presentedBeforeTransfer,
      verdict: rejected("ERR-InvalidPass"),
    });
    // A gate whose clock ran 30 s ahead of Kippu's, refused as expired.
    const expiredFromDriftingGate = report(event, "South door", {
      verdict: rejected("ERR-PassExpired"),
      deviceClock: now + 30_000,
    });
    // The same drift on an admission the ledger recorded: still flagged, as a clock only.
    const settledFromDriftingGate = report(event, "South door", { deviceClock: now - 15_000 });
    // Refusals none of the causes explain.
    const invalidWithoutTransfer = report(event, "North door", {
      verdict: rejected("ERR-InvalidPass"),
    });
    const expiredWithinTolerance = report(event, "North door", {
      verdict: rejected("ERR-PassExpired"),
      deviceClock: now + GATE_CLOCK_TOLERANCE_MS,
    });
    // Not flagged: a recorded admission within tolerance; a refusal at the gate; a failed submission.
    const fine = report(event, "North door", {});
    const refusedAtGate = report(event, "North door", {
      verdict: { kind: "refused", reason: "ERR-CannotAttend" },
    });
    const failed = report(event, "North door", {
      verdict: { kind: "admitted", submission: { outcome: "failed" } },
    });

    await north.operators.reportAdmission.mutate(recorded);
    await south.operators.reportAdmission.mutate(replayed);
    for (const input of [
      invalidAfterTransfer,
      invalidWithinTolerance,
      invalidTransferTooEarly,
      invalidWithoutHolder,
      invalidOtherHolder,
      invalidWithoutTransfer,
      expiredWithinTolerance,
      fine,
    ]) {
      await north.operators.reportAdmission.mutate(input);
    }
    await south.operators.reportAdmission.mutate(expiredFromDriftingGate);
    await south.operators.reportAdmission.mutate(settledFromDriftingGate);
    await north.operators.reportAdmission.mutate(refusedAtGate);
    await north.operators.reportAdmission.mutate(failed);

    // The copy, from backend-memory's log. The M3 rules do not accept transfers
    // (T-008-08, M4), so the transfer is a hand-built record appended to it (F-025 plan §7a).
    const prefix = (await wholeLog(harness.ledger.log)).map(({ cursor: _, ...record }) => record);
    const scripted = scriptedLog(prefix);
    const reader = createDerivedReader({
      store: harness.database.store,
      log: scripted.log,
      projections: [ledgerFactsProjection(harness.ledger)],
      onError: () => {},
    });
    await reader.catchUp();

    // Before the copy has read the transfer, nothing explains that refusal yet.
    const early = await flagsFor(organiser, event);
    expect(byReport(early.flags, invalidAfterTransfer.reportId)?.cause).toBe("unexplained");

    const receiver = hex(32) as AccountId;
    scripted.append({
      recordedAt: transferAt,
      event: { id: event, sequence: prefix.filter((record) => record.event?.id === event).length },
      entry: {
        command: {
          kind: "transferTicket",
          operationId: hex(16) as OperationId,
          expiresAt: 1_900_000_000_000,
          event,
          ticket,
          receiver,
        },
        authorisation: new Uint8Array(0) as Authorisation,
      },
      presentedAt: null,
    });
    await reader.catchUp();

    const { flags, freshness: read } = await flagsFor(organiser, event);
    expect(read.records).toBe(prefix.length + 1);

    expect(byReport(flags, replayed.reportId)).toMatchObject({
      cause: "same-pass-at-two-gates",
      gate: "South door",
      refusal: { errorCode: "ERR-PassReplayed" },
      otherReports: [{ reportId: recorded.reportId, gate: "North door", outcome: "settled" }],
    });
    expect(byReport(flags, invalidAfterTransfer.reportId)).toMatchObject({
      cause: "transfer-before-recording",
      refusal: { errorCode: "ERR-InvalidPass" },
      transfers: [{ from: holder, to: receiver, recordedAt: transferAt }],
    });
    expect(byReport(flags, invalidWithinTolerance.reportId)).toMatchObject({
      cause: "transfer-before-recording",
      transfers: [{ from: holder, to: receiver }],
    });
    for (const unexplained of [invalidTransferTooEarly, invalidWithoutHolder, invalidOtherHolder]) {
      expect(byReport(flags, unexplained.reportId)).toMatchObject({
        cause: "unexplained",
        refusal: { errorCode: "ERR-InvalidPass" },
        transfers: [],
      });
    }
    expect(byReport(flags, expiredFromDriftingGate.reportId)).toMatchObject({
      cause: "gate-clock-outside-tolerance",
      refusal: { errorCode: "ERR-PassExpired" },
      clockDrift: 30_000,
    });
    expect(byReport(flags, settledFromDriftingGate.reportId)).toMatchObject({
      cause: "gate-clock-outside-tolerance",
      refusal: null,
      clockDrift: -15_000,
    });
    expect(byReport(flags, invalidWithoutTransfer.reportId)).toMatchObject({
      cause: "unexplained",
      transfers: [],
    });
    expect(byReport(flags, expiredWithinTolerance.reportId)).toMatchObject({
      cause: "unexplained",
      clockDrift: GATE_CLOCK_TOLERANCE_MS,
    });

    // Nothing else is flagged, and flags come in the order the reports arrived.
    expect(flags.map((flag) => flag.reportId)).toEqual([
      replayed.reportId,
      invalidAfterTransfer.reportId,
      invalidWithinTolerance.reportId,
      invalidTransferTooEarly.reportId,
      invalidWithoutHolder.reportId,
      invalidOtherHolder.reportId,
      invalidWithoutTransfer.reportId,
      expiredWithinTolerance.reportId,
      expiredFromDriftingGate.reportId,
      settledFromDriftingGate.reportId,
    ]);
    for (const quiet of [recorded, fine, refusedAtGate, failed]) {
      expect(byReport(flags, quiet.reportId)).toBeUndefined();
    }

    // Another organiser reads none of these reports.
    const stranger = await harness.organiser();
    expect((await flagsFor(stranger, event)).flags).toEqual([]);
  });

  it("REQ-OP-3: a failed submission never recorded is flagged after its window; one recorded later is not", async () => {
    const organiser = await harness.organiser();
    const holder = simulatedWebAuthnSigner({ rpId: "holder.kippu.example" });
    const registered = await harness.ledger.registerCredential(holder.signer, {
      account: holder.signer.account,
      registration: holder.registration,
    });
    expect(registered).toMatchObject({ ok: true });
    const { event, ticket } = await eventWithTicket(organiser.organiserId, holder.signer.account);
    const north = await device(organiser, event, "North door");
    const { maxPassWindow, maxRecordingLag } = ledgerLimits();
    const failedSubmission: AdmissionReportInput["verdict"] = {
      kind: "admitted",
      submission: { outcome: "failed" },
    };

    // Presented now, its submission failed at the gate; recorded later by a retry.
    const now = Date.now();
    const pass = await producePass(
      { ticket: ticket as TicketId, holder: holder.signer.account, notBefore: now - 5_000 },
      holder.signer,
    );
    const recordedLater = report(event, "North door", {
      ticket,
      passId: pass.pass.id,
      presentedAt: now,
      verdict: failedSubmission,
    });
    // Presented long enough ago that no ledger could still record it, and never recorded.
    const longAgo = now - (maxPassWindow + maxRecordingLag + 60_000);
    const neverRecorded = report(event, "North door", {
      ticket,
      passId: hex(16),
      presentedAt: longAgo,
      verdict: failedSubmission,
    });
    // Presented now and not recorded yet: it still could be.
    const stillPending = report(event, "North door", {
      ticket,
      passId: hex(16),
      presentedAt: now,
      verdict: failedSubmission,
    });
    for (const input of [recordedLater, neverRecorded, stillPending]) {
      await north.operators.reportAdmission.mutate(input);
    }

    const reader = createDerivedReader({
      store: harness.database.store,
      log: harness.ledger.log,
      projections: [ledgerFactsProjection(harness.ledger)],
      onError: () => {},
    });
    await reader.catchUp();

    // Before the retry: the old one is past its deadline by the ledger's clock; neither recent one is.
    const before = await flagsFor(organiser, event);
    expect(before.flags.map((flag) => [flag.reportId, flag.cause])).toEqual([
      [neverRecorded.reportId, "not-recorded"],
    ]);
    expect(before.flags[0]).toMatchObject({
      refusal: null,
      recordingDeadline: longAgo + maxPassWindow + maxRecordingLag,
    });
    expect((before.freshness.lastRecordedAt ?? 0) > longAgo + maxPassWindow + maxRecordingLag).toBe(
      true,
    );

    // The retry reaches the ledger, which records the pass after the report arrived.
    const retried = await harness.ledger.submitAccessPass(pass, { presentedAt: now });
    expect(retried).toMatchObject({ ok: true, value: { operationId: pass.pass.id } });
    await reader.catchUp();

    // The copy holds the consumed pass, with its window and the ledger's recording time.
    const consumed = await createDerivedQueries(harness.database.store).consumedPass(
      ticket as TicketId,
      pass.pass.id as PassId,
    );
    expect(consumed.result?.value).toMatchObject({
      holder: holder.signer.account,
      notBefore: pass.pass.notBefore,
      notAfter: pass.pass.notAfter,
      presentedAt: now,
    });

    const after = await flagsFor(organiser, event);
    expect(after.flags.map((flag) => flag.reportId)).toEqual([neverRecorded.reportId]);
    expect(after.flags.map((flag) => flag.reportId)).not.toContain(recordedLater.reportId);
    expect(after.flags.map((flag) => flag.reportId)).not.toContain(stillPending.reportId);
  });
});
