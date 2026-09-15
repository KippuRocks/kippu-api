import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { GrantInput } from "../../src/operators/ports.js";
import { describeWithStore } from "../support/database.js";
import {
  type Client,
  type OperatorHarness,
  operatorHarness,
  refused,
} from "../support/operator-harness.js";

const HOUR = 60 * 60 * 1000;

describeWithStore("the operator authorisation check", () => {
  let harness: OperatorHarness;

  beforeAll(async () => {
    harness = await operatorHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  interface Setup {
    readonly organiser: Client;
    readonly event: string;
    readonly operator: string;
    /** A client in the operator's session. */
    readonly device: Client;
    grant(overrides?: Partial<GrantInput>): Promise<{ id: string; until: number }>;
  }

  async function setup(): Promise<Setup> {
    const { organiserId, client } = await harness.organiser();
    const event = await harness.createEvent(organiserId);
    const { id: operator } = await client.operators.create.mutate({ name: "Gate staff" });
    const { code } = await client.operators.issueEnrolmentCode.mutate({ operator });
    const { session } = await harness.client().auth.operator.redeemEnrolmentCode.mutate({ code });
    const from = harness.now().getTime();
    return {
      organiser: client,
      event,
      operator,
      device: harness.client(session.token),
      grant: (overrides = {}) =>
        client.operators.grants.create.mutate({
          operator,
          event,
          gates: ["North door"],
          from,
          until: from + 4 * HOUR,
          ...overrides,
        }),
    };
  }

  it("AC-E5.2: a revoked operator is refused on the next check", async () => {
    const context = await setup();
    const grant = await context.grant();

    expect(
      await context.device.operators.check.query({ event: context.event, gate: "North door" }),
    ).toEqual({
      event: context.event,
      gate: "North door",
      grant: grant.id,
      until: grant.until,
      checkedAt: harness.now().getTime(),
    });

    await context.organiser.operators.grants.revoke.mutate({ grant: grant.id });
    expect(
      await refused(() =>
        context.device.operators.check.query({ event: context.event, gate: "North door" }),
      ),
    ).toEqual({ code: "FORBIDDEN", reason: "grant-revoked" });
  });

  it("AC-E5.2: an operator whose sessions are revoked is refused on the next check", async () => {
    const context = await setup();
    await context.grant();
    const check = () =>
      context.device.operators.check.query({ event: context.event, gate: "North door" });
    await expect(check()).resolves.toBeDefined();

    await context.organiser.operators.revokeSessions.mutate({ operator: context.operator });
    expect(await refused(check)).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("AC-E5.2: a grant authorises only inside its window", async () => {
    const context = await setup();
    const start = harness.now().getTime() + HOUR;
    await context.grant({ from: start, until: start + HOUR });
    const check = () =>
      context.device.operators.check.query({ event: context.event, gate: "North door" });

    expect(await refused(check)).toEqual({ code: "FORBIDDEN", reason: "before-window" });
    harness.advance(HOUR);
    await expect(check()).resolves.toMatchObject({ until: start + HOUR });
    harness.advance(HOUR - 1);
    await expect(check()).resolves.toBeDefined();
    harness.advance(1);
    expect(await refused(check)).toEqual({ code: "FORBIDDEN", reason: "after-window" });
  });

  it("a grant authorises only its own gates, event and operator", async () => {
    const context = await setup();
    const other = await setup();
    await context.grant({ gates: ["North door", "South door"] });
    await other.grant();

    await expect(
      context.device.operators.check.query({ event: context.event, gate: "South door" }),
    ).resolves.toBeDefined();
    for (const input of [
      { event: context.event, gate: "West door" },
      { event: context.event, gate: "north door" },
      { event: other.event, gate: "North door" },
    ]) {
      expect(await refused(() => context.device.operators.check.query(input))).toEqual({
        code: "FORBIDDEN",
        reason: "not-granted",
      });
    }

    // A colleague under the same organiser holds no grant of their own.
    const { id: colleague } = await context.organiser.operators.create.mutate({ name: "Other" });
    const { code } = await context.organiser.operators.issueEnrolmentCode.mutate({
      operator: colleague,
    });
    const { session } = await harness.client().auth.operator.redeemEnrolmentCode.mutate({ code });
    expect(
      await refused(() =>
        harness
          .client(session.token)
          .operators.check.query({ event: context.event, gate: "North door" }),
      ),
    ).toEqual({ code: "FORBIDDEN", reason: "not-granted" });
  });

  it("a live grant authorises even when another grant for the gate was revoked", async () => {
    const context = await setup();
    const first = await context.grant();
    await context.organiser.operators.grants.revoke.mutate({ grant: first.id });
    const second = await context.grant();

    await expect(
      context.device.operators.check.query({ event: context.event, gate: "North door" }),
    ).resolves.toMatchObject({ grant: second.id });
  });

  it("only an operator checks", async () => {
    const context = await setup();
    expect(
      await refused(() =>
        context.organiser.operators.check.query({ event: context.event, gate: "North door" }),
      ),
    ).toMatchObject({ code: "FORBIDDEN", reason: null });
  });

  it("NFR-1: the check answers in under 100 ms at the 95th percentile", async () => {
    const context = await setup();
    await context.grant({ gates: Array.from({ length: 20 }, (_, i) => `Gate ${i}`) });
    // Other grants in the store, so the check reads through an index, not an empty table.
    for (let i = 0; i < 20; i++) {
      await (await setup()).grant();
    }
    const check = () =>
      context.device.operators.check.query({ event: context.event, gate: "Gate 7" });
    for (let i = 0; i < 20; i++) await check();

    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const started = performance.now();
      await check();
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] as number;
    expect(p95).toBeLessThan(100);
  });
});
