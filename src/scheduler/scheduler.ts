/**
 * In-process cron scheduler (DESIGN.md "Scheduling"): fires the weekly planning run at the
 * configured `cron_expression` (FR-9, default Sunday 18:00). Built on node-cron; the task
 * factory is injectable so tests trigger the tick themselves instead of waiting for the clock.
 */
import cron from "node-cron";
import type Database from "better-sqlite3";
import { readSetting } from "../db.js";
import { DEFAULT_CRON_EXPRESSION, SETTING_CRON_EXPRESSION, SETTING_TIMEZONE } from "../planner/settings.js";
import { runWeeklyPlanning, type WeeklyRunDeps } from "./run-weekly.js";
import { consoleLogger, type Logger } from "../logging/logger.js";
import { runWithRunId } from "../logging/run-context.js";

/** Sunday 18:00 in the scheduler's time zone. The single definition lives in src/planner/settings.ts. */
export const DEFAULT_CRON = DEFAULT_CRON_EXPRESSION;
export { SETTING_CRON_EXPRESSION, SETTING_TIMEZONE };

export interface ScheduledJob {
  stop(): void;
}

/** Registers `onTick` at `expression`; node-cron's `schedule` by default. */
export type ScheduleFactory = (expression: string, onTick: () => Promise<unknown>, options?: { timezone?: string }) => ScheduledJob;

export interface SchedulerOptions {
  cronExpression: string;
  /** IANA zone the expression is evaluated in; defaults to the process time zone. */
  timezone?: string;
  schedule?: ScheduleFactory;
  /** The server passes `app.ctx.log.child({ component: "scheduler" })`; defaults to the console. */
  logger?: Logger;
}

export interface Scheduler {
  stop(): void;
  /**
   * Replace the schedule (settings UI, #35). An invalid expression leaves nothing scheduled.
   * `timezone` replaces the zone too; omit it for the process time zone.
   */
  reschedule(cronExpression: string, timezone?: string): void;
  isScheduled(): boolean;
}

export type TickHandler = (deps: WeeklyRunDeps) => Promise<unknown>;

const nodeCronSchedule: ScheduleFactory = (expression, onTick, options) => {
  const task = cron.schedule(expression, onTick, { timezone: options?.timezone, noOverlap: true });
  return { stop: () => void task.destroy() };
};

/** The scheduler options stored in settings (`cron_expression`, `timezone`), with defaults. */
export function readSchedulerOptions(db: Database.Database): SchedulerOptions {
  const timezone = readSetting(db, SETTING_TIMEZONE);
  return { cronExpression: readSetting(db, SETTING_CRON_EXPRESSION) ?? DEFAULT_CRON, ...(timezone ? { timezone } : {}) };
}

export function startScheduler(deps: WeeklyRunDeps, options: SchedulerOptions, onTick: TickHandler = runWeeklyPlanning): Scheduler {
  const schedule = options.schedule ?? nodeCronSchedule;
  const logger = options.logger ?? consoleLogger;
  let job: ScheduledJob | undefined;

  // Each run gets its own `cron-<ISO>` runId, handed to the run as `deps.log`.
  // The run id is also the current run context, so shared loggers (the llm one) carry it too.
  const tick = () => {
    const runId = `cron-${new Date().toISOString()}`;
    return runWithRunId(runId, () => runTick(logger.child({ runId })));
  };
  const runTick = async (log: Logger) => {
    const started = Date.now();
    log.info({}, "run started");
    try {
      await onTick({ ...deps, log });
      log.info({ durationMs: Date.now() - started }, "run finished");
    } catch (error) {
      // `err` holds the Error itself so pino serializes its stack.
      log.error({ err: error, durationMs: Date.now() - started }, "run failed");
    }
  };

  let timezone = options.timezone;

  const register = (expression: string, zone?: string) => {
    timezone = zone;
    job?.stop();
    job = undefined;
    if (!cron.validate(expression)) {
      logger.error({ cronExpression: expression }, "invalid cron expression; weekly planning is not scheduled");
      return;
    }
    job = schedule(expression, tick, timezone ? { timezone } : undefined);
    logger.info({ cronExpression: expression, ...(timezone ? { timezone } : {}) }, "weekly planning scheduled");
  };

  register(options.cronExpression, options.timezone);
  return {
    stop: () => {
      job?.stop();
      job = undefined;
    },
    reschedule: register,
    isScheduled: () => job !== undefined,
  };
}
