/**
 * Capacity proofs and their review (`T-021-08`; `US-A6`, `REQ-EV-5`, `REQ-EV-6`,
 * `REQ-EV-7`, `NFR-6`; `F-021` plan §5.4). Types only: the published contract
 * (`C5`) re-exports them.
 */
import type { ActingPrincipal, ReviewerPrincipal } from "../auth/ports.js";

/** The artefact types a capacity proof may be: documents and scans with no active content. */
export type ProofArtefactMediaType = "application/pdf" | "image/jpeg" | "image/png";

/** An artefact attesting that the venue supports the capacity asked for. */
export interface ProofArtefactInput {
  readonly mediaType: ProofArtefactMediaType;
  /** The artefact's bytes, in standard base64. At most 2 MiB once decoded. */
  readonly data: string;
}

/** An organiser's request for an increase in an event's capacity. */
export interface RequestCapacityIncreaseInput {
  /** The `EventId`. */
  readonly event: string;
  /**
   * The capacity asked for, above the current bound. `null` removes the bound,
   * which counts as an increase (`REQ-EV-7`). Bounding an event with none is a
   * decrease (`events.decreaseCapacity`), and is refused here.
   */
  readonly capacity: number | null;
  readonly artefact: ProofArtefactInput;
}

export type CapacityProofStatus = "pending" | "approved" | "rejected";

/** A request for an increase, and how its review ended. */
export interface CapacityProofRequest {
  readonly id: string;
  /** The `EventId`. */
  readonly event: string;
  /** The capacity asked for; `null` removes the bound. */
  readonly capacity: number | null;
  readonly artefact: { readonly mediaType: ProofArtefactMediaType; readonly size: number };
  readonly status: CapacityProofStatus;
  /** Unix milliseconds. */
  readonly requestedAt: number;
  /** Unix milliseconds; `null` while pending. */
  readonly decidedAt: number | null;
  /** The proof id the ledger recorded with the increase; `null` unless approved. */
  readonly proofId: string | null;
  /** The ledger's cursor after the increase; `null` unless approved. */
  readonly cursor: string | null;
}

/** A request as Kippu's reviewers see it: with who asked and who decided. */
export interface ReviewedCapacityProofRequest extends CapacityProofRequest {
  readonly organiserId: string;
  /** The reviewer who decided; `null` while pending. */
  readonly reviewerId: string | null;
}

/** Names one capacity proof request. */
export interface CapacityProofRequestInput {
  readonly request: string;
}

/** A capacity proof's artefact, as the reviewer reads it. */
export interface ProofArtefact {
  readonly mediaType: ProofArtefactMediaType;
  /** Standard base64. */
  readonly data: string;
}

/** What caused a capacity proof call, and who made it. */
export interface ProofsRequest {
  readonly requestId: string;
  readonly principal: ActingPrincipal;
}

/** What caused a reviewer's decision. */
export interface ReviewRequest {
  readonly requestId: string;
  readonly principal: ReviewerPrincipal;
}

/**
 * What the capacity proof procedures reach. An organiser's request writes nothing
 * to the ledger; only a reviewer's approval does, with a proof id and the
 * organiser's authority. A refusal with a `SPEC.md` §10 code throws
 * `SpecCodeError`; one with none, `RefusedRequest`.
 */
export interface CapacityProofs {
  /**
   * Asks for an increase in the capacity of an event the organiser owns, storing
   * the artefact privately. Refused when the capacity is not an increase, when a
   * request for the event is already pending, and when the artefact is not an
   * accepted type or size.
   */
  request(
    organiserId: string,
    request: ProofsRequest,
    input: RequestCapacityIncreaseInput,
  ): Promise<CapacityProofRequest>;
  /** Every request for an event the organiser owns, newest first. */
  list(organiserId: string, input: { readonly event: string }): Promise<CapacityProofRequest[]>;
  /** The pending requests, oldest first: the review queue. */
  queue(): Promise<ReviewedCapacityProofRequest[]>;
  /** A request's artefact. */
  artefact(input: CapacityProofRequestInput): Promise<ProofArtefact>;
  /**
   * Approves a pending request: generates a proof id and submits the increase with
   * it. The ledger's refusal is passed on and leaves the request pending.
   */
  approve(
    request: ReviewRequest,
    input: CapacityProofRequestInput,
  ): Promise<ReviewedCapacityProofRequest>;
  /** Rejects a pending request. Nothing reaches the ledger. */
  reject(
    request: ReviewRequest,
    input: CapacityProofRequestInput,
  ): Promise<ReviewedCapacityProofRequest>;
}
