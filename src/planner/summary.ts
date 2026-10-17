import type Database from "better-sqlite3";
import { silentLogger, type Logger } from "../logging/logger.js";
import { listPlannedDinners } from "./repo.js";

/** The per-run `info` summary of a stored plan: dinners with a Dish, whether it degraded, sinks that accepted the list. */
export function logPlanSummary(
  log: Logger | undefined,
  db: Database.Database,
  planId: number,
  degradedReasons: string[],
  sinksPushed: number,
): void {
  const dinners = listPlannedDinners(db, planId).filter((d) => d.dishId !== null).length;
  (log ?? silentLogger).child({ component: "plan" }).info({ planId, dinners, degraded: degradedReasons.length > 0, sinksPushed }, "plan summary");
}
