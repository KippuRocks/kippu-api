/**
 * `@kippurocks/api` — the `C5` contract.
 *
 * Exports only types. Clients depend on this package by version and compile
 * their tRPC client against `AppRouter`; nothing of the server's
 * implementation ships in it.
 *
 * A failed call carries the `SPEC.md` §10 code, when there is one, verbatim in
 * `error.data.errorCode`.
 */

/** Events and classes (`F-021`): sale assets and prices, for Ibento and Ichiba. */
export type {
  CapacityChanged,
  CreateEventInput,
  DecreaseCapacityInput,
  DefineClassInput,
  EventPassWindow,
  EventSaleAsset,
  FinishSchedule,
  InvitationRefusal,
  RemoveRestrictionInput,
  RestrictionRemoved,
  SaleAsset,
  ScheduleFinishInput,
  SetClassPriceInput,
  SetPassWindowInput,
  SetSaleAssetInput,
  StatusChanged,
  TicketClass,
} from "../../../src/events/ports.js";
/** Operator authorisation (`F-024`): operator accounts, grants, the check and admission reports, for Ibento and Iriguchi. */
export type {
  AdmissionReport,
  AdmissionReportInput,
  AdmissionSubmission,
  CheckInput,
  CheckRefusal,
  CreateOperatorInput,
  EnrolmentCode,
  GrantIdInput,
  GrantInput,
  ListGrantsInput,
  OperatorAccount,
  OperatorAuthorisation,
  OperatorGrant,
  OperatorInput,
  OperatorRefusal,
  RevokedSessions,
} from "../../../src/operators/ports.js";
/** Capacity proofs (`T-021-08`): increases requested with an artefact, and Kippu's review queue. */
export type {
  CapacityProofRequest,
  CapacityProofRequestInput,
  CapacityProofStatus,
  ProofArtefact,
  ProofArtefactInput,
  ProofArtefactMediaType,
  RequestCapacityIncreaseInput,
  ReviewedCapacityProofRequest,
} from "../../../src/proofs/ports.js";
/** Kippu operations reviewers (`T-021-16`): enrolment and sign-in, for Ibento's review queue. */
export type {
  Reviewer,
  ReviewerEnrolmentChallenge,
  ReviewerSession,
  ReviewerSignInChallenge,
} from "../../../src/reviewers/ports.js";
/** Checkout (`F-022`): what Ichiba and Saifu exchange over a checkout, its Saifu handoff and its hold. */
export type {
  BeginCheckoutInput,
  BegunCheckout,
  Checkout,
  CheckoutAccount,
  CheckoutHold,
  CheckoutPayment,
  CheckoutRefund,
  CheckoutSale,
  CheckoutTokenInput,
  ClassOnSale,
  ConfirmLinkInput,
  GetCheckoutInput,
  HandoffLink,
  HandoffTokenInput,
  HoldOutcome,
  HoldRefusal,
  HoldStatus,
  PayCheckoutInput,
  SaifuHandoff,
  SaleInventory,
  SaleInventoryInput,
  ZoneOnSale,
} from "../../../src/sales/ports.js";
export type { AppRouter } from "../../../src/trpc/router.js";
