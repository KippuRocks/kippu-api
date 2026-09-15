import { randomUUID } from "node:crypto";
import type { EventId } from "@ticketto/sdk";
import type pg from "pg";
import type { OrganiserAuthority } from "../authority/authority.js";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { OrganiserSaleActions } from "../sales/organiser-actions.js";
import type { Store } from "../store/store.js";
import { ownedEvent } from "./ownership.js";
import type { EventInput, EventsRequest, FinishSchedule, ScheduleFinishInput } from "./ports.js";
import type { StatusTransitions } from "./status.js";

/** How long before a scheduled `Finished` its notice is due (`F-021` plan §5.5). */
export const FINISH_NOTICE_MS = 24 * 60 * 60 * 1000;

/** How often the scheduler looks for notices and finishes that are due. */
export const FINISH_SCHEDULER_INTERVAL_MS = 30 * 1000;

/**
 * How long past an unanswered submission's lifetime reconciliation still waits
 * before resuming a finish: allowance for the ledger's clock running behind Kippu's.
 */
export const OPERATION_EXPIRY_MARGIN_MS = 60 * 1000;

/** The advisory lock namespace a running finish is held under, per schedule. */
export const FINISH_RUN_LOCK_NAMESPACE = 0x66696e69;

/** A scheduled `Finished` whose notice fell due: what the organiser is told. */
export interface FinishNotice {
  readonly event: string;
  readonly organiserId: string;
  /** Unix milliseconds. */
  readonly at: number;
}

export interface FinishSchedules {
  schedule(
    organiserId: string,
    request: EventsRequest,
    input: ScheduleFinishInput,
  ): Promise<FinishSchedule>;
  cancel(organiserId: string, request: EventsRequest, input: EventInput): Promise<FinishSchedule>;
  get(organiserId: string, input: EventInput): Promise<FinishSchedule | null>;
  /**
   * One pass of the scheduler: reconciles every finish left running by a process
   * that is gone, gives every notice now due, then runs every finish now due.
   * Answers what it reconciled, noticed and ran.
   */
  runDue(): Promise<{
    readonly reconciled: number;
    readonly noticed: number;
    readonly ran: number;
  }>;
  /**
   * Reconciles every schedule left `running` that no live process holds, against
   * the ledger's status and the audit log (`T-021-17`). Answers how many it settled.
   */
  reconcile(): Promise<number>;
}

export interface FinishSchedulesOptions {
  readonly store: Store;
  readonly authority: Pick<OrganiserAuthority, "account">;
  readonly ledger: Pick<KippuTicketto, "getEvent">;
  readonly status: Pick<StatusTransitions, "finish">;
  /**
   * `F-022`'s organiser sale actions, resolved when called: reconciliation reopens
   * the sales a refused run had closed, as a refused finish does live.
   */
  readonly saleActions: () => Pick<OrganiserSaleActions, "reopenSales">;
  /**
   * How long an assembled command stays valid, in milliseconds: the SDK's
   * `operationLifetime`. A submission left without a verdict can be accepted until then.
   */
  readonly operationLifetime: number;
  /**
   * How a due notice reaches the organiser. V0 has no mail sender: by default the
   * notice is recorded on the schedule (`noticedAt`), for Ibento to show.
   */
  readonly notify?: (notice: FinishNotice) => Promise<void>;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

interface ScheduleRow {
  readonly id: string;
  readonly event: string;
  readonly organiser_id: string;
  readonly finish_at: Date;
  readonly status: FinishSchedule["status"];
  readonly noticed_at: Date | null;
  readonly error_code: string | null;
}

const COLUMNS = "id, event, organiser_id, finish_at, status, noticed_at, error_code";

/** The request a scheduled finish's write is audited under (`NFR-7`). */
const requestIdOf = (row: Pick<ScheduleRow, "id">) => `scheduled-finish:${row.id}`;

function scheduleOf(row: ScheduleRow): FinishSchedule {
  return {
    event: row.event,
    at: row.finish_at.getTime(),
    status: row.status,
    noticeAt: row.finish_at.getTime() - FINISH_NOTICE_MS,
    noticedAt: row.noticed_at === null ? null : row.noticed_at.getTime(),
    errorCode: row.error_code,
  };
}

/**
 * Scheduled `Finished` (`T-021-09`; `REQ-EV-12`; `F-021` plan §5.5): off by
 * default; the organiser sets a time, is noticed 24 hours before, and can cancel
 * until it runs. When it falls due Kippu finishes the event itself, with the
 * system principal attributed to the organiser who scheduled it (`NFR-7`) — the
 * same transition as a manual finish, `releaseAll` included for an event still
 * selling. A ledger refusal — the event cancelled meanwhile, say — is recorded on
 * the schedule, not retried. A run left without a verdict — the process stopped
 * mid-run, or the submission failed — stays `running` until reconciliation
 * (`T-021-17`) settles it without a second submission while the first can land.
 */
export function createFinishSchedules(options: FinishSchedulesOptions): FinishSchedules {
  const {
    store,
    authority,
    ledger,
    status,
    saleActions,
    operationLifetime,
    now = () => new Date(),
  } = options;
  const onError = options.onError ?? ((error: unknown) => console.error(error));
  const notify = options.notify ?? (async () => {});

  const read = async (event: string): Promise<ScheduleRow | null> =>
    (
      await store.query<ScheduleRow>(`SELECT ${COLUMNS} FROM finish_schedules WHERE event = $1`, [
        event,
      ])
    ).rows[0] ?? null;

  /**
   * Runs `work` holding the schedule's run lock, on a connection of its own; answers
   * `false` without running it when another process holds the lock. The lock is a
   * session lock: a process that dies mid-run releases it with its connection.
   */
  async function withRunLock(
    id: string,
    work: (client: pg.PoolClient) => Promise<void>,
  ): Promise<boolean> {
    const client = await store.connect();
    let broken: Error | undefined;
    try {
      const locked = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked",
        [FINISH_RUN_LOCK_NAMESPACE, id],
      );
      if (locked.rows[0]?.locked !== true) return false;
      try {
        await work(client);
      } finally {
        await client
          .query("SELECT pg_advisory_unlock($1, hashtext($2))", [FINISH_RUN_LOCK_NAMESPACE, id])
          .catch((error: Error) => {
            broken = error;
          });
      }
      return true;
    } finally {
      // A connection whose unlock failed is discarded, and its lock with it.
      client.release(broken);
    }
  }

  /** Runs a claimed finish, and records how it ended. */
  async function run(row: ScheduleRow): Promise<void> {
    const request: EventsRequest = {
      requestId: requestIdOf(row),
      principal: { kind: "system", organiserId: row.organiser_id, task: "scheduled-finish" },
    };
    try {
      await status.finish(row.organiser_id, request, row.event);
      await store.query(
        "UPDATE finish_schedules SET status = 'finished', ended_at = $2 WHERE id = $1",
        [row.id, now()],
      );
    } catch (error) {
      if (error instanceof SpecCodeError) {
        await store.query(
          `UPDATE finish_schedules SET status = 'refused', error_code = $2, ended_at = $3
           WHERE id = $1`,
          [row.id, error.code, now()],
        );
      }
      // No verdict: the finish stays running. The submission, if one was made, may
      // still be accepted, so reconciliation decides — never a second submission
      // while the first can land.
      onError(error);
    }
  }

  /**
   * Settles one schedule left running, holding its run lock (`T-021-17`):
   * 1. the ledger has the event `Finished` — whether this run's submission landed
   *    or anyone else's — so the schedule is `finished`, with nothing submitted;
   * 2. the audit log has the run's submission refused, so it is `refused`, with the
   *    ledger's code — and the event's sales, if this run closed them and they are
   *    still closed, reopen, as a refused finish's do live;
   * 3. a submission of the run is still without a verdict, and within its lifetime
   *    (plus {@link OPERATION_EXPIRY_MARGIN_MS}), so it may still land: the schedule
   *    stays `running`, for a later pass;
   * 4. otherwise nothing of the run can land any more — nothing was signed (every
   *    signature has a prior audit row, `NFR-7`), or what was has expired — so it
   *    is `scheduled` again, and runs as any due finish does.
   */
  async function settle(client: pg.PoolClient, row: ScheduleRow): Promise<boolean> {
    const found = await ledger.getEvent(row.event as EventId);
    if (!found.ok) throw new SpecCodeError(found.error.code, found.error.detail);
    if (found.value.status === "Finished") {
      await client.query(
        "UPDATE finish_schedules SET status = 'finished', ended_at = $2 WHERE id = $1",
        [row.id, now()],
      );
      return true;
    }
    const audited = await client.query<{
      outcome: "pending" | "settled" | "rejected" | "failed";
      error_code: string | null;
      recorded_at: Date;
    }>(
      `SELECT outcome, error_code, recorded_at FROM audit_log
       WHERE request_id = $1 AND command_kind = 'setEventStatus'
       ORDER BY recorded_at DESC`,
      [requestIdOf(row)],
    );
    const refused = audited.rows.find((entry) => entry.outcome === "rejected");
    if (refused !== undefined) {
      const closedByRun = await client.query(
        `SELECT 1 FROM event_sale_closures
         WHERE event = $1 AND closed_request_id = $2 AND reopened_at IS NULL`,
        [row.event, requestIdOf(row)],
      );
      if (closedByRun.rows.length > 0) {
        await saleActions().reopenSales(row.event, {
          requestId: requestIdOf(row),
          actor: { kind: "system", organiserId: row.organiser_id, task: "scheduled-finish" },
        });
      }
      await client.query(
        `UPDATE finish_schedules SET status = 'refused', error_code = $2, ended_at = $3
         WHERE id = $1`,
        [row.id, refused.error_code, now()],
      );
      return true;
    }
    const at = now().getTime();
    const mayLand = audited.rows.some(
      (entry) =>
        (entry.outcome === "pending" || entry.outcome === "failed") &&
        entry.recorded_at.getTime() + operationLifetime + OPERATION_EXPIRY_MARGIN_MS > at,
    );
    if (mayLand) return false;
    await client.query("UPDATE finish_schedules SET status = 'scheduled' WHERE id = $1", [row.id]);
    return true;
  }

  async function reconcile(): Promise<number> {
    const running = await store.query<{ id: string }>(
      "SELECT id FROM finish_schedules WHERE status = 'running' ORDER BY finish_at, id",
    );
    let settled = 0;
    for (const { id } of running.rows) {
      try {
        await withRunLock(id, async (client) => {
          const row = (
            await client.query<ScheduleRow>(
              `SELECT ${COLUMNS} FROM finish_schedules WHERE id = $1 AND status = 'running'`,
              [id],
            )
          ).rows[0];
          if (row !== undefined && (await settle(client, row))) settled += 1;
        });
      } catch (error) {
        // The ledger or the store is unavailable: left running, for the next pass.
        onError(error);
      }
    }
    return settled;
  }

  return {
    async schedule(organiserId, request, input) {
      const { event } = await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      if (event.status === "Cancelled" || event.status === "Finished") {
        throw new SpecCodeError(
          "ERR-InvalidTransition",
          `a ${event.status} event cannot become Finished`,
        );
      }
      if (input.at <= now().getTime()) {
        throw new RefusedRequest("a scheduled finish is in the future");
      }
      const at = now();
      const updated = await store.query<ScheduleRow>(
        `INSERT INTO finish_schedules
           (id, event, organiser_id, finish_at, set_request_id, set_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event) DO UPDATE
           SET finish_at = EXCLUDED.finish_at, organiser_id = EXCLUDED.organiser_id,
               status = 'scheduled', noticed_at = NULL, error_code = NULL, ended_at = NULL,
               set_request_id = EXCLUDED.set_request_id, set_at = EXCLUDED.set_at
           WHERE finish_schedules.status <> 'running' AND finish_schedules.status <> 'finished'
         RETURNING ${COLUMNS}`,
        [randomUUID(), input.event, organiserId, new Date(input.at), request.requestId, at],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new RefusedRequest("the scheduled finish has already run", "CONFLICT");
      }
      return scheduleOf(row);
    },

    async cancel(organiserId, _request, input) {
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      const updated = await store.query<ScheduleRow>(
        `UPDATE finish_schedules SET status = 'cancelled', ended_at = $2
         WHERE event = $1 AND status = 'scheduled'
         RETURNING ${COLUMNS}`,
        [input.event, now()],
      );
      const row = updated.rows[0];
      if (row !== undefined) return scheduleOf(row);
      const existing = await read(input.event);
      if (existing === null) {
        throw new RefusedRequest("the event has no scheduled finish", "NOT_FOUND");
      }
      if (existing.status === "cancelled") return scheduleOf(existing);
      throw new RefusedRequest("the scheduled finish has already run", "CONFLICT");
    },

    async get(organiserId, input) {
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      const row = await read(input.event);
      return row === null ? null : scheduleOf(row);
    },

    async runDue() {
      const reconciled = await reconcile();
      const at = now();
      const noticed = await store.query<ScheduleRow>(
        `UPDATE finish_schedules SET noticed_at = $1
         WHERE status = 'scheduled' AND noticed_at IS NULL
           AND finish_at - make_interval(secs => $2) <= $1
         RETURNING ${COLUMNS}`,
        [at, FINISH_NOTICE_MS / 1000],
      );
      for (const row of noticed.rows) {
        await notify({
          event: row.event,
          organiserId: row.organiser_id,
          at: row.finish_at.getTime(),
        }).catch(onError);
      }

      const due = await store.query<{ id: string }>(
        `SELECT id FROM finish_schedules
         WHERE status = 'scheduled' AND noticed_at IS NOT NULL AND finish_at <= $1
         ORDER BY finish_at, id`,
        [at],
      );
      let ran = 0;
      for (const { id } of due.rows) {
        await withRunLock(id, async (client) => {
          // Claimed under the schedule's lock, so two schedulers never run the same finish.
          const claimed = await client.query<ScheduleRow>(
            `UPDATE finish_schedules SET status = 'running'
             WHERE id = $1 AND status = 'scheduled' AND noticed_at IS NOT NULL AND finish_at <= $2
             RETURNING ${COLUMNS}`,
            [id, at],
          );
          const row = claimed.rows[0];
          if (row === undefined) return;
          ran += 1;
          await run(row);
        });
      }
      return { reconciled, noticed: noticed.rowCount ?? 0, ran };
    },

    reconcile,
  };
}

/**
 * The scheduler in the background: `runDue` once on start — so a finish a previous
 * process left running is reconciled at start-up (`T-021-17`) — then every
 * `FINISH_SCHEDULER_INTERVAL_MS`.
 */
export interface FinishScheduler {
  start(): void;
  stop(): Promise<void>;
}

export function finishScheduler(
  schedules: Pick<FinishSchedules, "runDue">,
  onError: (error: unknown) => void = (error) => console.error(error),
  intervalMs: number = FINISH_SCHEDULER_INTERVAL_MS,
): FinishScheduler {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  return {
    start() {
      if (timer !== undefined) return;
      const pass = () => {
        running = running.then(() => schedules.runDue().then(() => {}, onError));
      };
      timer = setInterval(pass, intervalMs);
      pass();
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
