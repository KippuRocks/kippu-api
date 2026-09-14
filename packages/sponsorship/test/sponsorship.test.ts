import { p256 } from "@noble/curves/nist.js";
import { createProfileV0, encodeAuthorisation, p256AccountId } from "@ticketto/profile-v0";
import { simulatedWebAuthnSigner, softwareP256Signer } from "@ticketto/profile-v0/testing";
import type {
  AccessPass,
  AccountId,
  Authorisation,
  Command,
  EventId,
  OperationId,
  PassId,
  SignedAccessPass,
  SignedCommand,
  TicketId,
  Timestamp,
} from "@ticketto/sdk";
import { describe, expect, it } from "vitest";
import {
  decodeSponsorship,
  encodeSponsorship,
  issueSponsorship,
  kmsP256Signer,
  SPONSORSHIP_SIGNING_TAG,
  sponsorshipSigningPayload,
  verifySponsorship,
} from "../src/index.js";
import { softwareKmsP256Key } from "../src/testing.js";

const RP_ID = "holders.example";
const profile = createProfileV0({ rpId: RP_ID });

const hex = (byte: number, length: number) => byte.toString(16).padStart(2, "0").repeat(length);

async function signedCommand(operationId = hex(1, 16)): Promise<SignedCommand> {
  const organiser = softwareP256Signer();
  const command: Command = {
    kind: "setEventStatus",
    operationId: operationId as OperationId,
    expiresAt: 1_900_000_000_000 as Timestamp,
    event: hex(7, 32) as EventId,
    status: "Cancelled",
  } as Command;
  return { command, authorisation: await organiser.signer.sign(profile.encodeCommand(command)) };
}

async function signedPass(passId = hex(1, 16)): Promise<SignedAccessPass> {
  const holder = softwareP256Signer();
  const pass: AccessPass = {
    ticket: hex(9, 32) as TicketId,
    holder: holder.signer.account,
    id: passId as PassId,
    notBefore: 1_800_000_000_000 as Timestamp,
    notAfter: 1_800_000_060_000 as Timestamp,
  };
  return { pass, authorisation: await holder.signer.sign(profile.encodePass(pass)) };
}

function sponsorKey() {
  const key = softwareKmsP256Key();
  const signer = kmsP256Signer(key);
  return { key, signer, sponsors: [signer.account] };
}

describe("sponsorship codec", () => {
  it("round-trips a command sponsorship and a pass sponsorship", async () => {
    const { signer } = sponsorKey();
    for (const input of [await signedCommand(), await signedPass()]) {
      const bytes = await issueSponsorship(signer, input, { notionalCost: 12_345n });
      const value = decodeSponsorship(bytes);
      expect(value.notionalCost).toBe(12_345n);
      expect(encodeSponsorship(value)).toEqual(bytes);
    }
  });

  it("binds a command sponsorship to its operation id and a pass sponsorship to its pass id", async () => {
    const { signer } = sponsorKey();
    const command = await signedCommand(hex(0xab, 16));
    const pass = await signedPass(hex(0xcd, 16));
    expect(
      decodeSponsorship(await issueSponsorship(signer, command, { notionalCost: 0n })).target,
    ).toEqual({ kind: "command", operationId: hex(0xab, 16) });
    expect(
      decodeSponsorship(await issueSponsorship(signer, pass, { notionalCost: 0n })).target,
    ).toEqual({ kind: "accessPass", passId: hex(0xcd, 16) });
  });

  it("lays out version, input kind, bound id, compact cost and the length-prefixed authorisation", () => {
    const authorisation = Uint8Array.of(1, 2, 3) as Authorisation;
    const bytes = encodeSponsorship({
      target: { kind: "accessPass", passId: hex(0x11, 16) as PassId },
      notionalCost: 1n,
      authorisation,
    });
    expect(Array.from(bytes)).toEqual([0, 1, ...Array(16).fill(0x11), 4, 12, 1, 2, 3]);
    const payload = sponsorshipSigningPayload(
      { kind: "accessPass", passId: hex(0x11, 16) as PassId },
      1n,
    );
    expect(payload.subarray(0, SPONSORSHIP_SIGNING_TAG.length)).toEqual(SPONSORSHIP_SIGNING_TAG);
    expect(Array.from(payload.subarray(SPONSORSHIP_SIGNING_TAG.length))).toEqual(
      Array.from(bytes.subarray(0, 19)),
    );
  });

  it("refuses a sponsorship that is not a canonical encoding", async () => {
    const { signer } = sponsorKey();
    const bytes = await issueSponsorship(signer, await signedCommand(), { notionalCost: 0n });
    const cases = [
      new Uint8Array(0),
      bytes.subarray(0, bytes.length - 1),
      Uint8Array.of(...bytes, 0),
      Uint8Array.of(1, ...bytes.subarray(1)),
      Uint8Array.of(0, 2, ...bytes.subarray(2)),
      // A non-minimal compact encoding of a zero cost.
      Uint8Array.of(...bytes.subarray(0, 18), 1, 0, ...bytes.subarray(19)),
    ];
    for (const bad of cases) expect(() => decodeSponsorship(bad)).toThrow();
  });

  it("refuses a notional cost outside u128", () => {
    const target = { kind: "command", operationId: hex(1, 16) as OperationId } as const;
    expect(() => sponsorshipSigningPayload(target, -1n)).toThrow(TypeError);
    expect(() => sponsorshipSigningPayload(target, 1n << 128n)).toThrow(TypeError);
  });
});

describe("sponsorship verification", () => {
  it("accepts a sponsorship of a signed command by a configured sponsor", async () => {
    const { signer, sponsors } = sponsorKey();
    const input = await signedCommand();
    const sponsorship = await issueSponsorship(signer, input, { notionalCost: 0n });
    expect(verifySponsorship(sponsorship, input, { sponsors })).toEqual({
      ok: true,
      value: { sponsor: signer.account, notionalCost: 0n },
    });
  });

  it("accepts a sponsorship of a signed access pass bound to its pass id", async () => {
    const { signer, sponsors } = sponsorKey();
    const input = await signedPass();
    const sponsorship = await issueSponsorship(signer, input, { notionalCost: 7n });
    expect(verifySponsorship(sponsorship, input, { sponsors })).toEqual({
      ok: true,
      value: { sponsor: signer.account, notionalCost: 7n },
    });
  });

  it("ERR-SponsorshipRefused: a sponsorship bound to another operation id", async () => {
    const { signer, sponsors } = sponsorKey();
    const sponsorship = await issueSponsorship(signer, await signedCommand(hex(1, 16)), {
      notionalCost: 0n,
    });
    const other = await signedCommand(hex(2, 16));
    expect(verifySponsorship(sponsorship, other, { sponsors })).toMatchObject({
      ok: false,
      error: { code: "ERR-SponsorshipRefused" },
    });
  });

  it("ERR-SponsorshipRefused: a pass sponsorship presented for a command with the same id", async () => {
    const { signer, sponsors } = sponsorKey();
    const id = hex(5, 16);
    const sponsorship = await issueSponsorship(signer, await signedPass(id), { notionalCost: 0n });
    expect(verifySponsorship(sponsorship, await signedCommand(id), { sponsors })).toMatchObject({
      ok: false,
      error: { code: "ERR-SponsorshipRefused" },
    });
  });

  it("ERR-SponsorshipRefused: a sponsorship signed by a key that is not a configured sponsor", async () => {
    const { sponsors } = sponsorKey();
    const forger = kmsP256Signer(softwareKmsP256Key());
    const input = await signedCommand();
    const sponsorship = await issueSponsorship(forger, input, { notionalCost: 0n });
    expect(verifySponsorship(sponsorship, input, { sponsors })).toMatchObject({
      ok: false,
      error: { code: "ERR-SponsorshipRefused" },
    });
  });

  it("ERR-SponsorshipRefused: a sponsorship whose cost or signature was altered", async () => {
    const { signer, sponsors } = sponsorKey();
    const input = await signedCommand();
    const value = decodeSponsorship(await issueSponsorship(signer, input, { notionalCost: 0n }));
    const recosted = encodeSponsorship({ ...value, notionalCost: 1n });
    const tampered = value.authorisation.slice();
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    const resigned = encodeSponsorship({ ...value, authorisation: tampered as Authorisation });
    for (const bytes of [recosted, resigned]) {
      expect(verifySponsorship(bytes, input, { sponsors })).toMatchObject({
        ok: false,
        error: { code: "ERR-SponsorshipRefused" },
      });
    }
  });

  it("ERR-SponsorshipRefused: a sponsorship authorised by a credential that is not p256", async () => {
    const holder = simulatedWebAuthnSigner({ rpId: RP_ID });
    const input = await signedCommand();
    const sponsorship = await issueSponsorship(holder.signer, input, { notionalCost: 0n });
    expect(
      verifySponsorship(sponsorship, input, { sponsors: [holder.signer.account] }),
    ).toMatchObject({ ok: false, error: { code: "ERR-SponsorshipRefused" } });
  });

  it("ERR-SponsorshipRefused: bytes that are not a sponsorship", async () => {
    const { sponsors } = sponsorKey();
    const input = await signedCommand();
    for (const bytes of [new Uint8Array(0), Uint8Array.of(0, 0, 1, 2, 3)]) {
      expect(verifySponsorship(bytes, input, { sponsors })).toMatchObject({
        ok: false,
        error: { code: "ERR-SponsorshipRefused" },
      });
    }
  });
});

describe("sponsor KMS signer", () => {
  it("produces the profile's p256 authorisation, verifiable against the key's registration", async () => {
    const secretKey = p256.utils.randomSecretKey();
    const software = softwareP256Signer({ secretKey });
    const signer = kmsP256Signer(softwareKmsP256Key({ secretKey }));
    expect(signer.account).toBe(software.signer.account);
    expect(signer.account).toBe(p256AccountId(p256.getPublicKey(secretKey, true)));

    const payload = sponsorshipSigningPayload(
      { kind: "command", operationId: hex(3, 16) as OperationId },
      0n,
    );
    const authorisation = await signer.sign(payload);
    expect(authorisation).toEqual(await software.signer.sign(payload));
    expect(profile.verify(software.registration, payload, authorisation)).toBe(true);
  });

  it("normalises a high-S DER signature from the KMS to low S", async () => {
    const secretKey = p256.utils.randomSecretKey();
    const publicKey = p256.getPublicKey(secretKey, true);
    const signer = kmsP256Signer({
      publicKey,
      async signDigest(digest) {
        const low = p256.Signature.fromBytes(
          p256.sign(digest, secretKey, { prehash: false, lowS: true }),
        );
        const high = new p256.Signature(low.r, p256.Point.Fn.ORDER - low.s);
        return { signature: high.toBytes("der"), format: "der" };
      },
    });
    const payload = Uint8Array.of(1, 2, 3);
    const authorisation = await signer.sign(payload);
    const software = softwareP256Signer({ secretKey });
    expect(profile.verify(software.registration, payload, authorisation)).toBe(true);
  });

  it("refuses a KMS signature that does not verify under the key's public key", async () => {
    const other = softwareKmsP256Key();
    const signer = kmsP256Signer({ ...softwareKmsP256Key(), signDigest: other.signDigest });
    await expect(signer.sign(Uint8Array.of(1))).rejects.toThrow(/does not verify/);
  });

  it("refuses a public key that is not a compressed P-256 key", () => {
    expect(() =>
      kmsP256Signer({
        publicKey: new Uint8Array(33),
        signDigest: async () => ({ signature: new Uint8Array(64), format: "compact" }),
      }),
    ).toThrow(TypeError);
  });

  it("carries only the profile's authorisation encoding", async () => {
    const key = softwareKmsP256Key();
    const signer = kmsP256Signer(key);
    const authorisation = await signer.sign(Uint8Array.of(9));
    const [version, kind] = authorisation;
    expect([version, kind]).toEqual([0, 1]);
    expect(authorisation.subarray(2, 35)).toEqual(key.publicKey);
    expect(authorisation.length).toBe(
      encodeAuthorisation({ kind: "p256", publicKey: key.publicKey, signature: new Uint8Array(64) })
        .length,
    );
    expect(signer.account satisfies AccountId).toBe(p256AccountId(key.publicKey));
  });
});
