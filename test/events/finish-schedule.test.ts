import type { EventId } from "@ticketto/sdk";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  createFinishSchedules,
  FINISH_NOTICE_MS,
  type FinishNotice,
  type FinishSchedules,
} from "../../src/events/finish-schedule.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  OPERATION_LIFETIME,
  randomId,
  refusal,
  type TestOrganiser,
} from "../support/events.js";

// Store-backed: generous timeouts, so a loaded CI host or database does not fail the suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HOUR = 60 * 60 * 1000;

describeWithStore("scheduled Finished", () => {
  let harness: EventsHarness;
  let clock: number;
  let notices: FinishNotice[];
  let schedules: FinishSchedules;

  beforeAll(async () => {
    harness = await eventsHarness();
    notices = [];
    clock = Date.now();
    schedules = createFinishSchedules({
      store: harness.database.store,
      authority: harness.authority,
      ledger: harness.ledger,
      status: harness.events.status,
      operationLifetime: OPERATION_LIFETIME,
      now: () => new Date(clock),
      notify: async (notice) => {
        notices.push(notice);
      },
      onError: () => {},
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  // Each test starts from its own clock and notices: nothing carries over between tests.
  beforeEach(() => {
    clock = Date.now();
    notices.length = 0;
  });

  async function setup(): Promise<{ organiser: TestOrganiser; event: string }> {
    const organiser = await harness.organiser();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: randomId(), kind: "Unseated" }],
      capacity: null,
    });
    return { organiser, event };
  }

  const statusOf = async (event: string) => {
    const found = await harness.ledger.getEvent(event as EventId);
    if (!found.ok) throw new Error(found.error.code);
    return found.value.status;
  };

  it("REQ-EV-12: off by default; a scheduled finish notifies 24 hours before, then finishes the event as the system principal, attributed to the organiser", async () => {
    const { organiser, event } = await setup();
    expect(await organiser.client.events.finishSchedule.query({ event })).toBeNull();

    const at = clock + 48 * HOUR;
    const set = await schedules.schedule(organiser.organiserId, organiser.request, { event, at });
    expect(set).toEqual({
      event,
      at,
      status: "scheduled",
      noticeAt: at - FINISH_NOTICE_MS,
      noticedAt: null,
      errorCode: null,
    });

    // A day early: nothing is due.
    clock += 23 * HOUR;
    expect(await schedules.runDue()).toMatchObject({ ran: 0 });
    expect(notices.filter((notice) => notice.event === event)).toEqual([]);

    // The notice falls due 24 hours before, once.
    clock += 2 * HOUR;
    await schedules.runDue();
    await schedules.runDue();
    expect(notices.filter((notice) => notice.event === event)).toEqual([
      { event, organiserId: organiser.organiserId, at },
    ]);
    expect(await organiser.client.events.finishSchedule.query({ event })).toMatchObject({
      status: "scheduled",
      noticedAt: clock,
    });
    expect(await statusOf(event)).toBe("Active");

    clock = at;
    await schedules.runDue();
    expect(await statusOf(event)).toBe("Finished");
    expect(await organiser.client.events.finishSchedule.query({ event })).toMatchObject({
      status: "finished",
    });

    // NFR-7: the write with no user behind it names the system principal and the organiser.
    const [scheduleId] = (
      await harness.database.store.query<{ id: string }>(
        "SELECT id FROM finish_schedules WHERE event = $1",
        [event],
      )
    ).rows.map((row) => row.id);
    const audited = await harness.database.store.query(
      `SELECT principal_kind, organiser_id, session_id, request_id, outcome FROM audit_log
       WHERE command_kind = 'setEventStatus' AND organiser_id = $1`,
      [organiser.organiserId],
    );
    expect(audited.rows).toEqual([
      {
        principal_kind: "system",
        organiser_id: organiser.organiserId,
        session_id: null,
        request_id: `scheduled-finish:${scheduleId}`,
        outcome: "settled",
      },
    ]);
    // Once run, it can no longer be cancelled or replaced.
    expect(
      await refusal(() => organiser.client.events.cancelScheduledFinish.mutate({ event })),
    ).toEqual({ code: "CONFLICT", errorCode: null });
  });

  it("REQ-EV-12: a scheduled finish is cancellable until it runs, and never runs once cancelled", async () => {
    const { organiser, event } = await setup();
    const at = clock + 2 * HOUR;
    await schedules.schedule(organiser.organiserId, organiser.request, { event, at });
    await schedules.runDue();
    expect(notices.some((notice) => notice.event === event)).toBe(true);

    expect(
      await schedules.cancel(organiser.organiserId, organiser.request, { event }),
    ).toMatchObject({ status: "cancelled" });
    clock = at + HOUR;
    await schedules.runDue();
    expect(await statusOf(event)).toBe("Active");
    expect(await schedules.get(organiser.organiserId, { event })).toMatchObject({
      status: "cancelled",
    });
  });

  it("a finish the ledger refuses when it runs is recorded as refused, with its code", async () => {
    const { organiser, event } = await setup();
    const at = clock + HOUR;
    await schedules.schedule(organiser.organiserId, organiser.request, { event, at });
    await organiser.client.events.cancel.mutate({ event });

    clock = at;
    await schedules.runDue();
    expect(await schedules.get(organiser.organiserId, { event })).toMatchObject({
      status: "refused",
      errorCode: "ERR-InvalidTransition",
    });
    expect(await statusOf(event)).toBe("Cancelled");
  });

  it("is set, read and cancelled by the organiser through tRPC, within its rules", async () => {
    const { organiser, event } = await setup();
    const at = Date.now() + 72 * HOUR;

    expect(await organiser.client.events.scheduleFinish.mutate({ event, at })).toMatchObject({
      event,
      at,
      status: "scheduled",
    });
    const later = at + HOUR;
    expect(await organiser.client.events.scheduleFinish.mutate({ event, at: later })).toMatchObject(
      { at: later, status: "scheduled" },
    );
    expect(await organiser.client.events.cancelScheduledFinish.mutate({ event })).toMatchObject({
      status: "cancelled",
    });

    expect(
      await refusal(() =>
        organiser.client.events.scheduleFinish.mutate({ event, at: Date.now() - 1000 }),
      ),
    ).toEqual({ code: "BAD_REQUEST", errorCode: null });
    const other = await harness.organiser();
    expect(await refusal(() => other.client.events.scheduleFinish.mutate({ event, at }))).toEqual({
      code: "FORBIDDEN",
      errorCode: "ERR-NotOwner",
    });
    await organiser.client.events.cancel.mutate({ event });
    expect(
      await refusal(() => organiser.client.events.scheduleFinish.mutate({ event, at })),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-InvalidTransition" });
  });
});
