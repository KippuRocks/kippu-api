// A client of the sponsor relay's plain-HTTP API (docs/sponsor-relay.md), as any
// Ticketto client would write it: `fetch`, JSON and the V0 profile. Nothing from
// tRPC or from kippu-api.

import { encodeSignedAccessPass, encodeSignedCommand } from "@ticketto/profile-v0";
import type { SignedAccessPass, SignedCommand } from "@ticketto/sdk";

export type SponsorResponse =
  | { readonly status: "sponsored"; readonly sponsorship: Uint8Array }
  | {
      readonly status: "refused" | "malformed" | "lagging" | "unavailable";
      readonly detail?: string;
    };

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

/** Asks the relay at `relayUrl` to sponsor a signed input. */
export async function requestSponsorship(
  relayUrl: string,
  input: SignedCommand | SignedAccessPass,
  after?: string,
): Promise<SponsorResponse> {
  const framed =
    "command" in input
      ? { kind: "command", bytes: toHex(encodeSignedCommand(input)) }
      : { kind: "pass", bytes: toHex(encodeSignedAccessPass(input)) };
  const response = await fetch(new URL("/v0/sponsor", relayUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(after === undefined ? { input: framed } : { input: framed, after }),
  });
  const body = (await response.json()) as {
    sponsorship?: string;
    error?: { code: string; detail?: string };
  };
  if (response.status === 200 && typeof body.sponsorship === "string") {
    return { status: "sponsored", sponsorship: fromHex(body.sponsorship) };
  }
  const detail = body.error?.detail;
  const status =
    body.error?.code === "ERR-SponsorshipRefused"
      ? "refused"
      : body.error?.code === "lagging"
        ? "lagging"
        : body.error?.code === "malformed"
          ? "malformed"
          : "unavailable";
  return detail === undefined ? { status } : { status, detail };
}
