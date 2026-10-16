import type Database from "better-sqlite3";
import { getPlanById } from "./plan-lookup.js";
import { getShoppingList } from "../shopping/build.js";
import { recordPush } from "./repo.js";
import { configuredSinks } from "./registry.js";
import type { Env, FetchLike, PushResult } from "./types.js";

export interface PushDeps {
  db: Database.Database;
  env?: Env;
  fetch?: FetchLike;
  now?: () => Date;
}

/**
 * Pushes ONLY the stored "Buy" section to every configured sink and records one `sink_push`
 * row per sink (FR-13). Never throws and never touches the plan (FR-14).
 */
export async function pushShoppingList(deps: PushDeps, planId: number): Promise<void> {
  try {
    const plan = getPlanById(deps.db, planId);
    if (!plan) return;
    const { buy } = getShoppingList(deps.db, planId);
    for (const sink of configuredSinks(deps.db, deps.env ?? process.env, deps.fetch)) {
      let result: PushResult;
      try {
        result = await sink.push({ weekStart: plan.weekStart, items: buy });
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      recordPush(deps.db, planId, sink.id, (deps.now?.() ?? new Date()).toISOString(), result);
    }
  } catch {
    // FR-14: a sink problem must never fail the plan.
  }
}
