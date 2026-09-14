// @kippu/sponsorship/testing — a software stand-in for the sponsor's KMS key, for
// local development and tests only. Its secret key is plain bytes in memory:
// never use it for a deployed sponsor.

import { p256 } from "@noble/curves/nist.js";
import type { KmsP256Key } from "./kms.js";

export interface SoftwareKmsP256KeyOptions {
  /** A 32-byte P-256 secret key. Defaults to a fresh random one. */
  readonly secretKey?: Uint8Array;
}

/**
 * A `KmsP256Key` in software. Like a KMS, it signs digests and returns DER
 * signatures, so the path a real provider takes is the one exercised.
 */
export function softwareKmsP256Key(options: SoftwareKmsP256KeyOptions = {}): KmsP256Key {
  const secretKey = options.secretKey?.slice() ?? p256.utils.randomSecretKey();
  if (!p256.utils.isValidSecretKey(secretKey)) {
    throw new TypeError("expected a valid P-256 secret key");
  }
  return {
    publicKey: p256.getPublicKey(secretKey, true),
    async signDigest(digest: Uint8Array) {
      if (digest.length !== 32) throw new TypeError("expected a 32-byte digest");
      return {
        signature: p256.sign(digest, secretKey, { prehash: false, format: "der" }),
        format: "der" as const,
      };
    },
  };
}
