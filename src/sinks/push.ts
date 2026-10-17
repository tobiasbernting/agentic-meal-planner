import { silentLogger, type Logger } from "../logging/logger.js";
import type Database from "better-sqlite3";
import { getPlanById } from "../planner/repo.js";
import { getShoppingList } from "../shopping/build.js";
import { recordPush } from "./repo.js";
import { configuredSinks } from "./registry.js";
import type { Env, FetchLike, PushResult } from "./types.js";

export interface PushDeps {
  db: Database.Database;
  env?: Env;
  fetch?: FetchLike;
  now?: () => Date;
  /** Run logger (bound to `runId`); defaults to `silentLogger`. */
  log?: Logger;
}

/**
 * Pushes ONLY the stored "Buy" section to every configured sink and records one `sink_push`
 * row per sink (FR-13). Never throws and never touches the plan (FR-14). A failed push is
 * also logged at warn. Returns how many sinks accepted the list.
 */
export async function pushShoppingList(deps: PushDeps, planId: number): Promise<number> {
  const log = (deps.log ?? silentLogger).child({ component: "sinks" });
  let pushed = 0;
  try {
    const plan = getPlanById(deps.db, planId);
    if (!plan) return 0;
    const { buy } = getShoppingList(deps.db, planId);
    for (const sink of configuredSinks(deps.db, deps.env ?? process.env, deps.fetch)) {
      let result: PushResult;
      try {
        result = await sink.push({ weekStart: plan.weekStart, items: buy });
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (result.ok) pushed += 1;
      else log.warn({ planId, sinkId: sink.id, reason: result.error }, "shopping list sink push failed");
      recordPush(deps.db, planId, sink.id, (deps.now?.() ?? new Date()).toISOString(), result);
    }
  } catch (err) {
    // FR-14: a sink problem must never fail the plan.
    log.warn({ planId, reason: err instanceof Error ? err.message : String(err), err }, "shopping list push aborted");
  }
  return pushed;
}
