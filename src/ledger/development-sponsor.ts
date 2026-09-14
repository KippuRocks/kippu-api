import { issueSponsorship, type KmsP256Key, kmsP256Signer } from "@kippu/sponsorship";
import { softwareKmsP256Key } from "@kippu/sponsorship/testing";
import type { Sponsor } from "@ticketto/sdk";

/**
 * A sponsor for development and tests, in kippu-api's own process: it sponsors
 * every input, at nil notional cost (`REQ-SP-1b`), with a software `p256` key.
 *
 * It issues real sponsorships in `@kippu/sponsorship`'s format, so the path a
 * deployed sponsor takes is the one exercised, but it evaluates no entitlement
 * (`REQ-SP-3`). `backend-memory` verifies no sponsorship, so nothing checks it
 * here. The sponsor relay's client (`T-023-07`) replaces it; it is never used in
 * production.
 */
export function developmentSponsor(key: KmsP256Key = softwareKmsP256Key()): Sponsor {
  const signer = kmsP256Signer(key);
  return {
    async sponsor(input) {
      return { ok: true, value: await issueSponsorship(signer, input, { notionalCost: 0n }) };
    },
  };
}
