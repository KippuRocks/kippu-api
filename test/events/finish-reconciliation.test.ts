import { randomBytes } from "node:crypto";
import type { EventId } from "@ticketto/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFinishSchedules,
  FINISH_RUN_LOCK_NAMESPACE,
  type FinishSchedules,
  finishScheduler,
  OPERATION_EXPIRY_MARGIN_MS,
} from "../../src/events/finish-schedule.js";
import type { EventsRequest } from "../../src/events/ports.js";
import type { StatusTransitions } from "../../src/events/status.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  OPERATION_LIFETIME,
  randomId,
  type TestOrganiser,
} from "../support/events.js";

// Store-backed: generous timeouts, so a loaded CI host or database does not fail the suite.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HOUR = 60 * 60 * 1000;

describe("the finish scheduler", () => {
  it("REQ-EV-12: runs a pass as soon as it starts, so a finish left running is reconciled at start-up", async () => {
    let passes = 0;
    const scheduler = finishScheduler(
      {
        runDue: async () => {
          passes += 1;
          return { reconciled: 0, noticed: 0, ran: 0 };
        },
      },
      () => {},
      HOUR,
    );
    scheduler.start();
    await scheduler.stop();
    expect(passes).toBe(1);
  });
});

describeWithStore("reconciling scheduled finishes left running", () => {
  let harness: EventsHarness;
  let clock: number;
  /** Replaces the status transitions the schedules run, for one test. */
  let finish: StatusTransitions["finish"];
  let schedules: FinishSchedules;

  beforeAll(async () => {
    harness = await eventsHarness();
    clock = Date.now();
    schedules = createFinishSchedules({
      store: harness.database.store,
      authority: harness.authority,
      ledger: harness.ledger,
      status: { finish: (...args) => finish(...args) },
      saleActions: () => harness.sales.organiserActions,
      operationLifetime: OPERATION_LIFETIME,
      now: () => new Date(clock),
      onError: () => {},
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  // Each test starts from its own clock and the real transition: nothing carries over.
  beforeEach(() => {
    clock = Date.now();
    finish = (...args) => harness.events.status.finish(...args);
  });

  interface Scheduled {
    readonly organiser: TestOrganiser;
    readonly event: string;
    readonly id: string;
    /** The request the schedule's write is audited under. */
    readonly request: EventsRequest;
  }

  /** An event whose scheduled finish is due now, noticed, and not yet run. */
  async function due(): Promise<Scheduled> {
    const organiser = await harness.organiser();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: randomId(), kind: "Unseated" }],
      capacity: null,
    });
    const at = clock + 2 * HOUR;
    await schedules.schedule(organiser.organiserId, organiser.request, { event, at });
    const { rows } = await harness.database.store.query<{ id: string }>(
      "UPDATE finish_schedules SET noticed_at = $2 WHERE event = $1 RETURNING id",
      [event, new Date(clock)],
    );
    clock = at;
    const id = rows[0]?.id as string;
    return {
      organiser,
      event,
      id,
      request: {
        requestId: `scheduled-finish:${id}`,
        principal: { kind: "system", organiserId: organiser.organiserId, task: "scheduled-finish" },
      },
    };
  }

  /** What a process that stopped mid-run leaves: the schedule claimed, and nothing recorded after. */
  const leftRunning = (scheduled: Scheduled) =>
    harness.database.store.query("UPDATE finish_schedules SET status = 'running' WHERE id = $1", [
      scheduled.id,
    ]);

  const scheduleOf = async (scheduled: Scheduled) =>
    schedules.get(scheduled.organiser.organiserId, { event: scheduled.event });

  const statusOf = async (event: string) => {
    const found = await harness.ledger.getEvent(event as EventId);
    if (!found.ok) throw new Error(found.error.code);
    return found.value.status;
  };

  /** Every `Finished` submission the schedule's request signed, by outcome. */
  const submissions = async (scheduled: Scheduled) =>
    (
      await harness.database.store.query<{ outcome: string }>(
        `SELECT outcome FROM audit_log
         WHERE request_id = $1 AND command_kind = 'setEventStatus' ORDER BY id`,
        [scheduled.request.requestId],
      )
    ).rows.map((row) => row.outcome);

  it("REQ-EV-12: a run interrupted before it submitted anything resumes, and finishes the event once", async () => {
    const scheduled = await due();
    await leftRunning(scheduled);
    expect(await submissions(scheduled)).toEqual([]);

    expect(await schedules.runDue()).toMatchObject({ reconciled: 1, ran: 1 });
    expect(await statusOf(scheduled.event)).toBe("Finished");
    expect(await scheduleOf(scheduled)).toMatchObject({ status: "finished" });
    expect(await submissions(scheduled)).toEqual(["settled"]);
  });

  it("REQ-EV-12: a run interrupted after the ledger accepted its finish completes, with no second submission", async () => {
    const scheduled = await due();
    await harness.events.status.finish(
      scheduled.organiser.organiserId,
      scheduled.request,
      scheduled.event,
    );
    await leftRunning(scheduled);

    expect(await schedules.runDue()).toMatchObject({ reconciled: 1, ran: 0 });
    expect(await scheduleOf(scheduled)).toMatchObject({ status: "finished" });
    expect(await submissions(scheduled)).toEqual(["settled"]);
  });

  it("REQ-EV-12: a submission that lost its verdict stays running, and is never submitted again once it landed", async () => {
    const scheduled = await due();
    // The ledger accepts the finish, and the process never learns of it.
    finish = async (...args) => {
      await harness.events.status.finish(...args);
      throw new Error("the connection to the ledger was lost");
    };
    expect(await schedules.runDue()).toMatchObject({ ran: 1 });
    expect(await scheduleOf(scheduled)).toMatchObject({ status: "running" });

    finish = (...args) => harness.events.status.finish(...args);
    expect(await schedules.runDue()).toMatchObject({ reconciled: 1, ran: 0 });
    expect(await scheduleOf(scheduled)).toMatchObject({ status: "finished" });
    expect(await submissions(scheduled)).toEqual(["settled"]);
  });

  it("REQ-EV-12: a submission still without a verdict is waited for until it can no longer land, then the run resumes", async () => {
    const scheduled = await due();
    await leftRunning(scheduled);
    // A submission was signed and never answered: it may still land within its lifetime.
    await harness.database.store.query(
      `INSERT INTO audit_log
         (request_id, principal_kind, organiser_id, operation_id, command_kind, recorded_at)
       VALUES ($1, 'system', $2, $3, 'setEventStatus', $4)`,
      [
        scheduled.request.requestId,
        scheduled.organiser.organiserId,
        randomBytes(16).toString("hex"),
        new Date(clock),
      ],
    );

    clock += OPERATION_LIFETIME;
    expect(await schedules.runDue()).toMatchObject({ reconciled: 0, ran: 0 });
    expect(await scheduleOf(scheduled)).toMatchObject({ status: "running" });
    expect(await statusOf(scheduled.event)).toBe("Active");

    clock += OPERATION_EXPIRY_MARGIN_MS + 1;
    expect(await schedules.runDue()).toMatchObject({ reconciled: 1, ran: 1 });
    expect(await statusOf(scheduled.event)).toBe("Finished");
    expect(await scheduleOf(scheduled)).toMatchObject({ status: "finished" });
    expect(await submissions(scheduled)).toEqual(["pending", "settled"]);
  });

  it("REQ-EV-12: a run whose finish the ledger refused before the interruption is recorded as refused, not retried", async () => {
    const scheduled = await due();
    await scheduled.organiser.client.events.cancel.mutate({ event: scheduled.event });
    await expect(
      harness.events.status.finish(
        scheduled.organiser.organiserId,
        scheduled.request,
        scheduled.event,
      ),
    ).rejects.toMatchObject({ code: "ERR-InvalidTransition" });
    await leftRunning(scheduled);

    expect(await schedules.runDue()).toMatchObject({ reconciled: 1, ran: 0 });
    expect(await scheduleOf(scheduled)).toMatchObject({
      status: "refused",
      errorCode: "ERR-InvalidTransition",
    });
    expect(await submissions(scheduled)).toEqual(["rejected"]);
  });

  /** A refused submission of the run, recorded before the process stopped. */
  const refusedSubmission = (scheduled: Scheduled) =>
    harness.database.store.query(
      `INSERT INTO audit_log
         (request_id, principal_kind, organiser_id, operation_id, command_kind, recorded_at,
          outcome, error_code, completed_at)
       VALUES ($1, 'system', $2, $3, 'setEventStatus', $4, 'rejected', 'ERR-InvalidTransition', $4)`,
      [
        scheduled.request.requestId,
        scheduled.organiser.organiserId,
        randomBytes(16).toString("hex"),
        new Date(clock),
      ],
    );

  /** The event's sale closures, oldest first: who closed them, and who reopened them. */
  const closures = async (event: string) =>
    (
      await harness.database.store.query<{
        closed_request_id: string;
        reopened_request_id: string | null;
      }>(
        `SELECT closed_request_id, reopened_request_id FROM event_sale_closures
         WHERE event = $1 ORDER BY id`,
        [event],
      )
    ).rows;

  it("REQ-HD-4: a refused run that had closed the event's sales reopens them, as a refused finish does live", async () => {
    const scheduled = await due();
    // The run closed sales, and its finish was refused; the process stopped before reopening them.
    await harness.sales.organiserActions.releaseAll(scheduled.event, {
      requestId: scheduled.request.requestId,
      actor: scheduled.request.principal,
    });
    await refusedSubmission(scheduled);
    await leftRunning(scheduled);

    expect(await schedules.runDue()).toMatchObject({ reconciled: 1, ran: 0 });
    expect(await scheduleOf(scheduled)).toMatchObject({
      status: "refused",
      errorCode: "ERR-InvalidTransition",
    });
    expect(await closures(scheduled.event)).toEqual([
      {
        closed_request_id: scheduled.request.requestId,
        reopened_request_id: scheduled.request.requestId,
      },
    ]);
  });

  it("REQ-HD-4: a refused run leaves closed the sales something else closed", async () => {
    const scheduled = await due();
    await harness.sales.organiserActions.releaseAll(scheduled.event, {
      requestId: "organiser-seal",
      actor: scheduled.organiser.request.principal,
    });
    await refusedSubmission(scheduled);
    await leftRunning(scheduled);

    expect(await schedules.runDue()).toMatchObject({ reconciled: 1, ran: 0 });
    expect(await scheduleOf(scheduled)).toMatchObject({ status: "refused" });
    expect(await closures(scheduled.event)).toEqual([
      { closed_request_id: "organiser-seal", reopened_request_id: null },
    ]);
  });

  it("REQ-EV-12: a run another live process holds is left to it", async () => {
    const scheduled = await due();
    await leftRunning(scheduled);
    const holder = await harness.database.store.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1, hashtext($2))", [
        FINISH_RUN_LOCK_NAMESPACE,
        scheduled.id,
      ]);
      expect(await schedules.runDue()).toMatchObject({ reconciled: 0, ran: 0 });
      expect(await scheduleOf(scheduled)).toMatchObject({ status: "running" });
      expect(await submissions(scheduled)).toEqual([]);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
        FINISH_RUN_LOCK_NAMESPACE,
        scheduled.id,
      ]);
      holder.release();
    }

    expect(await schedules.runDue()).toMatchObject({ reconciled: 1, ran: 1 });
    expect(await statusOf(scheduled.event)).toBe("Finished");
  });
});
