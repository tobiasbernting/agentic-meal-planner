/**
 * In-process cron scheduler (DESIGN.md "Scheduling"): fires the weekly planning run at the
 * configured `cron_expression` (FR-9, default Sunday 18:00). Built on node-cron; the task
 * factory is injectable so tests trigger the tick themselves instead of waiting for the clock.
 */
import cron from "node-cron";
import type Database from "better-sqlite3";
import { readSetting } from "../db.js";
import { runWeeklyPlanning, type WeeklyRunDeps } from "./run-weekly.js";

/** Sunday 18:00 in the scheduler's time zone. */
export const DEFAULT_CRON = "0 18 * * 0";
export const SETTING_CRON_EXPRESSION = "cron_expression";
export const SETTING_TIMEZONE = "timezone";

export interface ScheduledJob {
  stop(): void;
}

/** Registers `onTick` at `expression`; node-cron's `schedule` by default. */
export type ScheduleFactory = (expression: string, onTick: () => Promise<unknown>, options?: { timezone?: string }) => ScheduledJob;

export interface SchedulerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SchedulerOptions {
  cronExpression: string;
  /** IANA zone the expression is evaluated in; defaults to the process time zone. */
  timezone?: string;
  schedule?: ScheduleFactory;
  logger?: SchedulerLogger;
}

export interface Scheduler {
  stop(): void;
  /** Replace the schedule (settings UI, #35). An invalid expression leaves nothing scheduled. */
  reschedule(cronExpression: string): void;
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
  const logger = options.logger ?? console;
  let job: ScheduledJob | undefined;

  const tick = async () => {
    try {
      await onTick(deps);
      logger.info("weekly planning run finished");
    } catch (error) {
      logger.error(`weekly planning run failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const register = (expression: string) => {
    job?.stop();
    job = undefined;
    if (!cron.validate(expression)) {
      logger.error(`invalid cron expression "${expression}": weekly planning is not scheduled`);
      return;
    }
    job = schedule(expression, tick, options.timezone ? { timezone: options.timezone } : undefined);
    logger.info(`weekly planning scheduled at "${expression}"${options.timezone ? ` (${options.timezone})` : ""}`);
  };

  register(options.cronExpression);
  return {
    stop: () => {
      job?.stop();
      job = undefined;
    },
    reschedule: register,
    isScheduled: () => job !== undefined,
  };
}
