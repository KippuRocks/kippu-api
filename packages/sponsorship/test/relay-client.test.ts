import { createProfileV0 } from "@ticketto/profile-v0";
import { softwareP256Signer } from "@ticketto/profile-v0/testing";
import type {
  AccessPass,
  Command,
  Cursor,
  EventId,
  OperationId,
  PassId,
  SignedAccessPass,
  SignedCommand,
  TicketId,
  Timestamp,
} from "@ticketto/sdk";
import { describe, expect, it } from "vitest";
import { createRelaySponsor, RelayProtocolError } from "../src/index.js";

const profile = createProfileV0({ rpId: "holder.kippu.example" });

async function command(): Promise<SignedCommand> {
  const signer = softwareP256Signer().signer;
  const value: Command = {
    kind: "setEventStatus",
    operationId: "01".repeat(16) as OperationId,
    expiresAt: 1_900_000_000_000 as Timestamp,
    event: "07".repeat(32) as EventId,
    status: "Sealed",
  };
  return { command: value, authorisation: await signer.sign(profile.encodeCommand(value)) };
}

async function pass(): Promise<SignedAccessPass> {
  const signer = softwareP256Signer().signer;
  const value: AccessPass = {
    ticket: "09".repeat(32) as TicketId,
    holder: signer.account,
    id: "02".repeat(16) as PassId,
    notBefore: 1_800_000_000_000 as Timestamp,
    notAfter: 1_800_000_060_000 as Timestamp,
  };
  return { pass: value, authorisation: await signer.sign(profile.encodePass(value)) };
}

interface Call {
  readonly url: string;
  readonly body: { input: { kind: string; bytes: string }; after?: string };
}

function relay(answers: (() => Response)[]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("no more answers");
    return answer();
  }) as unknown as typeof globalThis.fetch;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { calls, sleeps, fetch, sleep };
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

describe("relay sponsor client", () => {
  it("REQ-SP-1a: returns the relay's sponsorship as opaque bytes, and nothing about cost", async () => {
    const fake = relay([json(200, { sponsorship: "00ff10" })]);
    const sponsor = createRelaySponsor({ url: "https://relay.example", ...fake });
    const result = await sponsor.sponsor(await command());
    expect(result).toEqual({ ok: true, value: Uint8Array.of(0, 255, 16) });
    expect(fake.calls[0]?.url).toBe("https://relay.example/v0/sponsor");
    expect(fake.calls[0]?.body.input.kind).toBe("command");
    expect(fake.calls[0]?.body.after).toBeUndefined();
  });

  it("frames an access pass as a pass, and sends the caller's receipt cursor as after", async () => {
    const fake = relay([json(200, { sponsorship: "01" })]);
    const sponsor = createRelaySponsor({
      url: "https://relay.example",
      receiptCursor: () => "42" as Cursor,
      ...fake,
    });
    await sponsor.sponsor(await pass());
    expect(fake.calls[0]?.body.input.kind).toBe("pass");
    expect(fake.calls[0]?.body.after).toBe("42");
  });

  it("ERR-SponsorshipRefused: a refusal is returned at once, never retried", async () => {
    const fake = relay([
      json(403, { error: { code: "ERR-SponsorshipRefused", detail: "the signer does not own" } }),
    ]);
    const sponsor = createRelaySponsor({ url: "https://relay.example", ...fake });
    expect(await sponsor.sponsor(await command())).toEqual({
      ok: false,
      error: { code: "ERR-SponsorshipRefused", detail: "the signer does not own" },
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("REQ-SP-5: a lagging relay is retried after Retry-After, with the same input", async () => {
    const fake = relay([
      json(503, { error: { code: "lagging" } }, { "retry-after": "2" }),
      json(503, { error: { code: "unavailable" } }),
      json(200, { sponsorship: "0a" }),
    ]);
    const sponsor = createRelaySponsor({ url: "https://relay.example", backoff: 100, ...fake });
    expect(await sponsor.sponsor(await command())).toEqual({ ok: true, value: Uint8Array.of(10) });
    expect(fake.sleeps).toEqual([2000, 200]);
    expect(new Set(fake.calls.map((call) => JSON.stringify(call.body))).size).toBe(1);
  });

  it("a relay that cannot be reached is retried, then answers ERR-LedgerUnavailable", async () => {
    const down = () => {
      throw new TypeError("fetch failed");
    };
    const fake = relay([down, down, down]);
    const sponsor = createRelaySponsor({
      url: "https://relay.example",
      attempts: 3,
      backoff: 10,
      ...fake,
    });
    expect(await sponsor.sponsor(await command())).toMatchObject({
      ok: false,
      error: { code: "ERR-LedgerUnavailable" },
    });
    expect(fake.calls).toHaveLength(3);
    expect(fake.sleeps).toEqual([10, 20]);
  });

  it("treats an undocumented answer, a malformed one included, as a defect", async () => {
    for (const answer of [
      json(400, { error: { code: "malformed" } }),
      json(200, { sponsorship: "xyz" }),
      json(500, { error: { code: "internal" } }),
    ]) {
      const sponsor = createRelaySponsor({ url: "https://relay.example", ...relay([answer]) });
      await expect(sponsor.sponsor(await command())).rejects.toThrow(RelayProtocolError);
    }
  });
});
