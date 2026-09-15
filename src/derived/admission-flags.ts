/**
 * Provisional-admission matching and organiser flags (`T-025-06`; `REQ-OP-3`,
 * `F-025` plan §5.5).
 *
 * An admission decided at the gate before the ledger records it is provisional.
 * Each admission report from `F-024` is matched with the ledger's outcome for its
 * pass — the gate's own submission result, and the transfers the derived copy
 * holds — and a refused admission is flagged with its cause:
 *
 * | Cause | Detected by |
 * |---|---|
 * | Same pass admitted at two gates | Refused as `ERR-PassReplayed`, and another report admitted the pass |
 * | Transfer between verdict and recording | Refused as `ERR-InvalidPass`, with a transfer of the ticket recorded between `presentedAt` and the report's `receivedAt` |
 * | Gate clock outside tolerance | Refused as `ERR-PassExpired`, from a gate whose clock was more than 10 s from Kippu's |
 *
 * A report from a gate whose clock is outside tolerance is flagged whatever its
 * outcome (plan §5.5). The gate's clock is `deviceClock`, compared with Kippu's
 * `receivedAt`.
 *
 * Flags are computed when read, from the reports and the copy as they are then,
 * so a refusal whose transfer the copy has not yet read is `unexplained` until it
 * has. Every time in a report is the gate's claim, and Kippu's copy is not
 * authoritative (`REQ-IX-1`): a flag is evidence for the organiser, never a
 * ledger fact.
 */
import type { TicketId } from "@ticketto/sdk";
import type { AdmissionReports, StoredAdmissionReport } from "../operators/reports.js";
import type { CopyFreshness } from "./freshness.js";
import type { AdmissionFlag, AdmissionFlagCause, FlagTransfer, RelatedReport } from "./ports.js";
import type { DerivedQueries } from "./queries.js";

/** How far a gate's clock may drift from Kippu's before it is flagged (plan §5.5). */
export const GATE_CLOCK_TOLERANCE_MS = 10_000;

export interface MatchedFlags {
  readonly flags: readonly AdmissionFlag[];
  readonly freshness: CopyFreshness;
}

function outcomeOf(report: StoredAdmissionReport): RelatedReport["outcome"] {
  return report.verdict.kind === "refused" ? "refused-at-gate" : report.verdict.submission.outcome;
}

/** Every report for an event, in the order received. */
async function reportsFor(
  reports: Pick<AdmissionReports, "list">,
  event: string,
): Promise<StoredAdmissionReport[]> {
  const all: StoredAdmissionReport[] = [];
  let after = 0;
  for (;;) {
    const page = await reports.list({ event, after });
    if (page.reports.length === 0) return all;
    all.push(...page.reports);
    after = page.next;
  }
}

export async function matchAdmissionFlags(
  reports: Pick<AdmissionReports, "list">,
  queries: Pick<DerivedQueries, "transfers">,
  current: () => Promise<CopyFreshness>,
  organiserId: string,
  event: string,
): Promise<MatchedFlags> {
  // Read the copy's position first: a flag is never classified with more than it says.
  const freshness = await current();
  const own = (await reportsFor(reports, event)).filter(
    (report) => report.organiserId === organiserId,
  );
  const byPass = new Map<string, StoredAdmissionReport[]>();
  for (const report of own) {
    byPass.set(report.passId, [...(byPass.get(report.passId) ?? []), report]);
  }

  const flags: AdmissionFlag[] = [];
  for (const report of own) {
    const clockDrift = report.deviceClock - report.receivedAt;
    const clockOutside = Math.abs(clockDrift) > GATE_CLOCK_TOLERANCE_MS;
    const { verdict } = report;
    const errorCode =
      verdict.kind === "admitted" && verdict.submission.outcome === "rejected"
        ? verdict.submission.errorCode
        : null;
    if (errorCode === null && !clockOutside) continue;

    const others = (byPass.get(report.passId) ?? []).filter((other) => other !== report);
    let transfers: FlagTransfer[] = [];
    let cause: AdmissionFlagCause;
    if (errorCode === null) {
      cause = "gate-clock-outside-tolerance";
    } else if (
      errorCode === "ERR-PassReplayed" &&
      others.some((other) => other.verdict.kind === "admitted")
    ) {
      cause = "same-pass-at-two-gates";
    } else if (errorCode === "ERR-InvalidPass") {
      const read = await queries.transfers(
        report.ticket as TicketId,
        report.presentedAt,
        report.receivedAt,
      );
      transfers = read.result
        .filter(({ sequence }) => sequence < freshness.records)
        .map(({ value, sequence }) => ({
          from: value.from,
          to: value.to,
          recordedAt: value.recordedAt,
          sequence,
        }));
      cause = transfers.length > 0 ? "transfer-before-recording" : "unexplained";
    } else if (errorCode === "ERR-PassExpired" && clockOutside) {
      cause = "gate-clock-outside-tolerance";
    } else {
      cause = "unexplained";
    }

    flags.push({
      reportId: report.reportId,
      gate: report.gate,
      operator: report.operator,
      ticket: report.ticket,
      passId: report.passId,
      refusal: errorCode === null ? null : { errorCode },
      cause,
      presentedAt: report.presentedAt,
      deviceClock: report.deviceClock,
      receivedAt: report.receivedAt,
      clockDrift,
      otherReports: others.map((other) => ({
        reportId: other.reportId,
        gate: other.gate,
        operator: other.operator,
        outcome: outcomeOf(other),
        receivedAt: other.receivedAt,
      })),
      transfers,
    });
  }
  return { flags, freshness };
}
