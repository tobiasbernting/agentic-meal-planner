import type Database from "better-sqlite3";
import type { PushResult } from "./types.js";

export interface SinkPush {
  planId: number;
  sinkId: string;
  pushedAt: string;
  ok: boolean;
  error: string | null;
  detail: string | null;
}

export function recordPush(db: Database.Database, planId: number, sinkId: string, pushedAt: string, result: PushResult): void {
  db.prepare("INSERT INTO sink_push (plan_id, sink_id, pushed_at, ok, error, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
    planId,
    sinkId,
    pushedAt,
    result.ok ? 1 : 0,
    result.ok ? null : result.error,
    result.ok ? (result.detail ?? null) : null,
  );
}

/** Latest push per sink for a plan (most recent attempt wins), ordered by sink id. */
export function latestPushes(db: Database.Database, planId: number): SinkPush[] {
  const rows = db
    .prepare(
      `SELECT plan_id, sink_id, pushed_at, ok, error, detail FROM sink_push
       WHERE id IN (SELECT MAX(id) FROM sink_push WHERE plan_id = ? GROUP BY sink_id) ORDER BY sink_id`,
    )
    .all(planId) as { plan_id: number; sink_id: string; pushed_at: string; ok: number; error: string | null; detail: string | null }[];
  return rows.map((r) => ({ planId: r.plan_id, sinkId: r.sink_id, pushedAt: r.pushed_at, ok: r.ok === 1, error: r.error, detail: r.detail }));
}
