/**
 * The household's minute tick (ADR-0010), beside the weekly planning cron: once a day it prunes
 * Activity and the re-add tray to 30 days. Each tick is cheap and never throws; the
 * schedule factory is injectable so tests run ticks themselves.
 */
import cron from "node-cron";
import type Database from "better-sqlite3";
import { pruneActivity } from "../lists/activity.js";
import { consoleLogger, type Logger } from "../logging/logger.js";
import { householdToday } from "../planner/settings.js";
import type { ScheduleFactory, ScheduledJob } from "./scheduler.js";

export interface HouseholdTickDeps {
  db: Database.Database;
  now: () => Date;
  log?: Logger;
}

/** What the tick remembers between runs. */
export interface HouseholdTickState {
  /** The household date of the last prune. */
  prunedOn?: string;
}

export async function householdTick(deps: HouseholdTickDeps, state: HouseholdTickState): Promise<void> {
  const log = deps.log ?? consoleLogger;
  try {
    const now = deps.now();
    const today = householdToday(deps.db, now);
    if (state.prunedOn !== today) {
      pruneActivity(deps.db, now.toISOString());
      state.prunedOn = today;
    }
  } catch (error) {
    log.error({ err: error }, "household tick failed");
  }
}

const everyMinute: ScheduleFactory = (expression, onTick) => {
  const task = cron.schedule(expression, onTick, { noOverlap: true });
  return { stop: () => void task.destroy() };
};

/** Runs `householdTick` every minute until stopped. */
export function startHouseholdTick(deps: HouseholdTickDeps, schedule: ScheduleFactory = everyMinute): ScheduledJob {
  const state: HouseholdTickState = {};
  return schedule("* * * * *", () => householdTick(deps, state));
}
