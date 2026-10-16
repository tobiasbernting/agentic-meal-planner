import type Database from "better-sqlite3";

export function getPlanById(db: Database.Database, planId: number): { weekStart: string } | undefined {
  const row = db.prepare("SELECT week_start FROM weekly_plan WHERE id = ?").get(planId) as { week_start: string } | undefined;
  return row ? { weekStart: row.week_start } : undefined;
}
