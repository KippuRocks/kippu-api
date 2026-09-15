import { DEFAULT_PASS_WINDOW } from "@ticketto/profile-v0";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MIN_PASS_WINDOW_MS } from "../../src/events/pass-window.js";
import { ledgerLimits } from "../../src/ledger/rules.js";
import { describeWithStore } from "../support/database.js";
import { type EventsHarness, eventsHarness, randomId, refusal } from "../support/events.js";

// Store-backed: generous timeouts, so a loaded CI host or database does not fail the suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describeWithStore("per-event pass window", () => {
  let harness: EventsHarness;
  const { maxPassWindow } = ledgerLimits();

  beforeAll(async () => {
    harness = await eventsHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  async function event() {
    const organiser = await harness.organiser();
    const created = await organiser.client.events.create.mutate({
      zones: [{ id: randomId(), kind: "Unseated" }],
      capacity: null,
    });
    return { organiser, event: created.event };
  }

  it("NFR-5: an event's pass window defaults to 60 seconds, within bounds from the ledger's configuration", async () => {
    const { organiser, event: id } = await event();

    expect(DEFAULT_PASS_WINDOW).toBe(60_000);
    expect(maxPassWindow).toBe(5 * 60 * 1000);
    expect(await organiser.client.events.passWindow.query({ event: id })).toEqual({
      event: id,
      windowMs: 60_000,
      isDefault: true,
      minimumMs: 10_000,
      maximumMs: maxPassWindow,
    });
  });

  it("NFR-5: the window round-trips, at either bound and between them", async () => {
    const { organiser, event: id } = await event();

    for (const windowMs of [MIN_PASS_WINDOW_MS, 90_000, maxPassWindow]) {
      expect(
        await organiser.client.events.setPassWindow.mutate({ event: id, windowMs }),
      ).toMatchObject({ event: id, windowMs, isDefault: false });
      expect(await organiser.client.events.passWindow.query({ event: id })).toMatchObject({
        windowMs,
        isDefault: false,
      });
    }
  });

  it("REQ-AP-3: a window outside its bounds is refused, and the window in force is kept", async () => {
    const { organiser, event: id } = await event();
    await organiser.client.events.setPassWindow.mutate({ event: id, windowMs: 45_000 });

    for (const windowMs of [MIN_PASS_WINDOW_MS - 1, maxPassWindow + 1, 0, -1000, 12_500.5]) {
      expect(
        await refusal(() => organiser.client.events.setPassWindow.mutate({ event: id, windowMs })),
      ).toEqual({ code: "BAD_REQUEST", errorCode: null });
    }
    expect(await organiser.client.events.passWindow.query({ event: id })).toMatchObject({
      windowMs: 45_000,
    });
  });

  it("is the organiser's: another organiser can neither read nor set it", async () => {
    const { event: id } = await event();
    const other = await harness.organiser();

    expect(await refusal(() => other.client.events.passWindow.query({ event: id }))).toEqual({
      code: "FORBIDDEN",
      errorCode: "ERR-NotOwner",
    });
    expect(
      await refusal(() =>
        other.client.events.setPassWindow.mutate({ event: id, windowMs: 30_000 }),
      ),
    ).toEqual({ code: "FORBIDDEN", errorCode: "ERR-NotOwner" });
    expect(
      await refusal(() => harness.holder().client.events.passWindow.query({ event: id })),
    ).toEqual({ code: "FORBIDDEN", errorCode: null });
  });
});
