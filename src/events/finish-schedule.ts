import { randomUUID } from "node:crypto";
import type { EventId } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import { ownedEvent } from "./ownership.js";
import type { EventInput, EventsRequest, FinishSchedule, ScheduleFinishInput } from "./ports.js";
import type { StatusTransitions } from "./status.js";

/** How long before a scheduled `Finished` its notice is due (`F-021` plan §5.5). */
export const FINISH_NOTICE_MS = 24 * 60 * 60 * 1000;

/** How often the scheduler looks for notices and finishes that are due. */
export const FINISH_SCHEDULER_INTERVAL_MS = 30 * 1000;

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
   * One pass of the scheduler: gives every notice now due, then runs every finish
   * now due. Answers what it noticed and what it ran.
   */
  runDue(): Promise<{ readonly noticed: number; readonly ran: number }>;
}

export interface FinishSchedulesOptions {
  readonly store: Store;
  readonly authority: Pick<OrganiserAuthority, "account">;
  readonly ledger: Pick<KippuTicketto, "getEvent">;
  readonly status: Pick<StatusTransitions, "finish">;
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
 * the schedule, not retried.
 */
export function createFinishSchedules(options: FinishSchedulesOptions): FinishSchedules {
  const { store, authority, ledger, status, now = () => new Date() } = options;
  const onError = options.onError ?? ((error: unknown) => console.error(error));
  const notify = options.notify ?? (async () => {});

  const read = async (event: string): Promise<ScheduleRow | null> =>
    (
      await store.query<ScheduleRow>(`SELECT ${COLUMNS} FROM finish_schedules WHERE event = $1`, [
        event,
      ])
    ).rows[0] ?? null;

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

      // Claimed one statement at a time, so two schedulers never run the same finish.
      const due = await store.query<ScheduleRow>(
        `UPDATE finish_schedules SET status = 'running'
         WHERE status = 'scheduled' AND noticed_at IS NOT NULL AND finish_at <= $1
         RETURNING ${COLUMNS}`,
        [at],
      );
      for (const row of due.rows) {
        const request: EventsRequest = {
          requestId: `scheduled-finish:${row.id}`,
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
          } else {
            // No verdict: back to scheduled, to run on the next pass.
            await store.query("UPDATE finish_schedules SET status = 'scheduled' WHERE id = $1", [
              row.id,
            ]);
          }
          onError(error);
        }
      }
      return { noticed: noticed.rowCount ?? 0, ran: due.rowCount ?? 0 };
    },
  };
}

/** The scheduler in the background: `runDue` every `FINISH_SCHEDULER_INTERVAL_MS`. */
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
      timer = setInterval(() => {
        running = running.then(() => schedules.runDue().then(() => {}, onError));
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
