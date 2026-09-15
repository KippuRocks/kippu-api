/**
 * Reads of ledger facts from Kippu's derived copy, joined with their public
 * metadata, for Saifu, Ibento and Ichiba (`F-025` plan §2, `AC-A3.2`).
 *
 * This module is imported by the tRPC context, whose type is published in
 * `@kippu/api`: it may import nothing at runtime, and names no SDK type.
 * Identifiers cross it as lower-case hex strings; ledger times as Unix
 * milliseconds.
 */

/** A JSON value, as a metadata document holds it. */
export type ReadJson =
  | null
  | boolean
  | number
  | string
  | readonly ReadJson[]
  | { readonly [field: string]: ReadJson };

/** How far the copy had read the ledger's log when a response was read (`NFR-11`). */
export interface ReadFreshness {
  /** The cursor of the last log record the copy reflects; `""` before the first. */
  readonly cursor: string;
  /** How many log records the copy reflects. */
  readonly records: number;
  /** When the ledger recorded the last of them; `null` before the first. */
  readonly lastRecordedAt: number | null;
}

/**
 * Every view of a ledger fact says it is a copy (`REQ-IX-1`): where it and the
 * ledger disagree, the ledger wins (`REQ-IX-2`).
 */
export interface CopiedFact {
  readonly authoritative: false;
  /** The log sequence of the last record that changed the fact. */
  readonly sequence: number;
}

/**
 * An event, as one object of ledger facts and platform metadata (`AC-A3.2`).
 * Every field but `metadata` is a ledger fact.
 */
export interface EventView extends CopiedFact {
  readonly id: string;
  /** The owner's ledger account. */
  readonly owner: string;
  readonly status: "Active" | "Sealed" | "Cancelled" | "Finished";
  /** `null`: issuance is unbounded (`REQ-EV-3`). */
  readonly maxCapacity: number | null;
  readonly issued: number;
  readonly zones: readonly { readonly id: string; readonly kind: "Seated" | "Unseated" }[];
  /** The stable locator the ledger records for the event's document (`REQ-MD-1`). */
  readonly metadataLocator: string | null;
  /**
   * The event document at that locator (`F-026`), or `null` when there is none
   * Kippu hosts. A client renders the event from the ledger facts alone then
   * (`REQ-MD-2`).
   */
  readonly metadata: { readonly [field: string]: ReadJson } | null;
}

/** A ticket, as one object of ledger facts and its class's platform metadata. */
export interface TicketView extends CopiedFact {
  readonly id: string;
  readonly event: string;
  readonly holder: string;
  /** The opaque `ClassId` (`REQ-TC-2`). */
  readonly class: string;
  readonly provenance: "Purchased" | "Granted";
  readonly zone: string;
  readonly placement:
    | { readonly kind: "Seated"; readonly position: string }
    | { readonly kind: "Unseated"; readonly discriminator: string };
  readonly policy:
    | { readonly kind: "Single" }
    | { readonly kind: "Multiple"; readonly max: number; readonly until: number | null }
    | { readonly kind: "Unlimited"; readonly until: number | null };
  readonly restrictions: { readonly cannotResale: boolean; readonly cannotTransfer: boolean };
  /** Recorded attendances (`INV-3`). */
  readonly attendances: number;
  /**
   * The class as Kippu defines it (`REQ-TC-2`): its name, so a class is legible
   * through Kippu before any document is written (`AC-B2.6`). `null` when Kippu
   * holds no definition for the ticket's class id — a ticket issued by some
   * other Ticketto client, say. Kippu data, not a ledger fact.
   */
  readonly kippuClass: { readonly name: string } | null;
  /** The class document's locator, derived from the class id (`F-026` plan §5.1). */
  readonly classMetadataLocator: string;
  /** The class document, or `null` when Kippu hosts none: the class is then legible only by its ledger facts. */
  readonly classMetadata: { readonly [field: string]: ReadJson } | null;
}

/** A ticket an account holds, with its event. */
export interface HoldingView {
  readonly ticket: TicketView;
  /** `null` only if the copy holds the ticket but not yet its event, which the log order rules out. */
  readonly event: EventView | null;
}

export interface EventRead {
  /** `null` when the copy holds no such event — not yet, or not at all. */
  readonly event: EventView | null;
  readonly freshness: ReadFreshness;
}

export interface EventsRead {
  readonly events: readonly EventView[];
  readonly freshness: ReadFreshness;
}

/** One page of the public index of events on sale (`T-025-10`). */
export interface EventsOnSalePage {
  /** Events on sale, most recently created first. */
  readonly events: readonly EventView[];
  /** Pass as `page` to read the next page; `null` on the last. Opaque. */
  readonly nextPage: string | null;
  readonly freshness: ReadFreshness;
}

export interface HoldingsRead {
  readonly holdings: readonly HoldingView[];
  readonly freshness: ReadFreshness;
}

export interface WaitedFor {
  /** Whether the copy reflects the record at the cursor waited for. */
  readonly reached: boolean;
  readonly freshness: ReadFreshness;
}

/**
 * Why a provisional admission was flagged (`REQ-OP-3`, `F-025` plan §5.5).
 *
 * - `same-pass-at-two-gates` — refused as `ERR-PassReplayed`, and another report
 *   admitted the same pass.
 * - `transfer-before-recording` — refused as `ERR-InvalidPass`, with a transfer
 *   of the ticket recorded between the gate's verdict and the report of the refusal.
 * - `gate-clock-outside-tolerance` — the gate's clock was more than 10 s from
 *   Kippu's: for a refusal, one as `ERR-PassExpired`; or on any report at all.
 * - `unexplained` — the ledger refused the admission for none of the causes above.
 */
export type AdmissionFlagCause =
  | "same-pass-at-two-gates"
  | "transfer-before-recording"
  | "gate-clock-outside-tolerance"
  | "unexplained";

/** How a report for the same pass ended, as its gate reported it. */
export interface RelatedReport {
  readonly reportId: string;
  readonly gate: string;
  readonly operator: string;
  readonly outcome: "settled" | "rejected" | "failed" | "refused-at-gate";
  /** Unix ms, Kippu's clock. */
  readonly receivedAt: number;
}

/** A transfer of the flagged ticket, from the derived copy. */
export interface FlagTransfer {
  readonly from: string;
  readonly to: string;
  /** Unix ms, the ledger's clock. */
  readonly recordedAt: number;
  readonly sequence: number;
}

/** A flagged admission report, for the organiser (`REQ-OP-3`). */
export interface AdmissionFlag {
  readonly reportId: string;
  readonly gate: string;
  readonly operator: string;
  readonly ticket: string;
  readonly passId: string;
  /** The ledger's refusal of the provisional admission; `null` when only the gate's clock is flagged. */
  readonly refusal: { readonly errorCode: string } | null;
  readonly cause: AdmissionFlagCause;
  /** Unix ms: when the pass was presented, as the gate submitted it. */
  readonly presentedAt: number;
  /** Unix ms: the gate device's own clock when it reported. */
  readonly deviceClock: number;
  /** Unix ms: Kippu's clock when the report arrived. */
  readonly receivedAt: number;
  /** `deviceClock − receivedAt`, in ms. */
  readonly clockDrift: number;
  /** Every other report for the same pass, in the order received. */
  readonly otherReports: readonly RelatedReport[];
  /** Transfers of the ticket recorded between the verdict and the report. */
  readonly transfers: readonly FlagTransfer[];
}

export interface AdmissionFlagsRead {
  /** In the order the flagged reports were received. */
  readonly flags: readonly AdmissionFlag[];
  /**
   * How far the copy had read the log. A transfer the copy has not yet read
   * cannot explain a refusal, so a flag may move from `unexplained` to
   * `transfer-before-recording` once the copy catches up.
   */
  readonly freshness: ReadFreshness;
}

/** What the read routers reach. */
export interface Reads {
  /** An event, by id. Public: browsing needs no account (`REQ-MP-7`). */
  event(event: string): Promise<EventRead>;
  /**
   * The public index of events on sale: `Active` events with a `Purchased` class,
   * most recently created first, `limit` at a time, continuing after `page`.
   * Public: browsing needs no account (`REQ-MP-7`). A malformed `page` is refused
   * with `RefusedRequest`.
   */
  eventsOnSale(limit: number, page: string | null): Promise<EventsOnSalePage>;
  /** The events the organiser's ledger account owns, most recently created first. */
  organiserEvents(organiserId: string): Promise<EventsRead>;
  /**
   * The organiser's flagged admissions for an event: every provisional admission
   * the ledger refused, with its cause, and every report from a gate whose clock
   * was outside tolerance (`REQ-OP-3`). Only reports from the organiser's own
   * operators are read.
   */
  admissionFlags(organiserId: string, event: string): Promise<AdmissionFlagsRead>;
  /** The tickets a holder's account holds, by event (`US-D1`, `US-E1`). */
  holdings(account: string): Promise<HoldingsRead>;
  /** Waits, up to `timeout` ms, until the copy reflects a write's receipt cursor (`F-025` plan §5.3). */
  waitFor(cursor: string, timeout: number): Promise<WaitedFor>;
}
