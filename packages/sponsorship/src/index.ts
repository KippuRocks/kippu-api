// @kippu/sponsorship — sponsorships bound to an operation id or pass id, their
// verification, and the sponsor's p256 KMS signer (F-023, T-023-01; REQ-SP-1,
// REQ-SP-1b). Design: features/023-sponsorship/plan.md in KippuRocks/kippu-docs.
//
// The hosted ledger service consumes this package to verify sponsorships
// (F-010 §5.3); the sponsor relay uses it to issue them.

export { type KmsP256Key, type KmsSignature, kmsP256Signer } from "./kms.js";
export {
  BOUND_ID_LENGTH,
  decodeSponsorship,
  encodeSponsorship,
  INPUT_DIGEST_LENGTH,
  type IssueOptions,
  issueSponsorship,
  SPONSORSHIP_FORMAT_VERSION,
  SPONSORSHIP_SIGNING_TAG,
  type SponsoredInput,
  type SponsorshipTarget,
  type SponsorshipValue,
  signedInputDigest,
  sponsorshipSigningPayload,
  sponsorshipTarget,
  type VerifiedSponsorship,
  type VerifyOptions,
  verifySponsorship,
} from "./sponsorship.js";
