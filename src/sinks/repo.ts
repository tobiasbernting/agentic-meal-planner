import type Database from "better-sqlite3";
import type { PushResult } from "./types.js";

export interface SinkPush {
  /** The Plan Run that triggered the push; null for a manual Skicka igen. */
  planId: number | null;
  sinkId: string;
  pushedAt: string;
  ok: boolean;
  error: string | null;
  detail: string | null;
  /** Fingerprint of the Buy list that was sent (`buyFingerprint`); null for pushes recorded before it existed. */
  buyHash: string | null;
}

export function recordPush(
  db: Database.Database,
  planId: number | null,
  sinkId: string,
  pushedAt: string,
  result: PushResult,
  buyHash: string,
): void {
  db.prepare("INSERT INTO sink_push (plan_id, sink_id, pushed_at, ok, error, detail, buy_hash) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    planId,
    sinkId,
    pushedAt,
    result.ok ? 1 : 0,
    result.ok ? null : result.error,
    result.ok ? (result.detail ?? null) : null,
    buyHash,
  );
}

/** Latest push per sink (most recent attempt wins), ordered by sink id. The list is one, so pushes are not per plan. */
export function latestPushes(db: Database.Database): SinkPush[] {
  const rows = db
    .prepare(
      `SELECT plan_id, sink_id, pushed_at, ok, error, detail, buy_hash FROM sink_push
       WHERE id IN (SELECT MAX(id) FROM sink_push GROUP BY sink_id) ORDER BY sink_id`,
    )
    .all() as { plan_id: number | null; sink_id: string; pushed_at: string; ok: number; error: string | null; detail: string | null; buy_hash: string | null }[];
  return rows.map((r) => ({
    planId: r.plan_id,
    sinkId: r.sink_id,
    pushedAt: r.pushed_at,
    ok: r.ok === 1,
    error: r.error,
    detail: r.detail,
    buyHash: r.buy_hash,
  }));
}
