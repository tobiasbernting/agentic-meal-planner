/**
 * Weekly Plan storage: one `weekly_plan` row per week (Monday) with its seven
 * `planned_dinner` rows. A Dish being deleted empties the dinner rather than the plan.
 */
import type Database from "better-sqlite3";
import type { PlanWeekResult, RecentlyPlanned } from "./plan-week.js";

export type PlanStatus = "generated" | "confirmed";

export interface PlannedDinner {
  date: string;
  dishId: number | null;
  isQuickDay: boolean;
  lunchThatDay: string | null;
  rationale: string;
  /** Recipe link for an LLM-found recipe (ADR-0003); filled by the ingredients step. */
  sourceUrl: string | null;
}

export interface WeeklyPlan {
  id: number;
  weekStart: string;
  generatedAt: string;
  status: PlanStatus;
  degradedReasons: string[];
  dinners: PlannedDinner[];
}

interface PlanRow {
  id: number;
  week_start: string;
  generated_at: string;
  status: PlanStatus;
  degraded_reasons: string;
}

interface DinnerRow {
  date: string;
  dish_id: number | null;
  is_quick_day: number;
  lunch_that_day: string | null;
  selection_rationale: string;
  source_url: string | null;
}

/** Saves (replacing any existing plan for that week) and returns the plan id. Status resets to `generated`. */
export function savePlan(db: Database.Database, plan: PlanWeekResult, generatedAt: string): number {
  return db.transaction(() => {
    db.prepare("DELETE FROM weekly_plan WHERE week_start = ?").run(plan.weekStart);
    const result = db
      .prepare("INSERT INTO weekly_plan (week_start, generated_at, status, degraded_reasons) VALUES (?, ?, 'generated', ?)")
      .run(plan.weekStart, generatedAt, JSON.stringify(plan.degradedReasons));
    const id = Number(result.lastInsertRowid);
    const insert = db.prepare(
      `INSERT INTO planned_dinner (plan_id, date, dish_id, is_quick_day, lunch_that_day, selection_rationale)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const d of plan.dinners) {
      insert.run(id, d.date, d.dishId, d.isQuickDay ? 1 : 0, d.lunchThatDay, d.rationale);
    }
    return id;
  })();
}

export function getPlanForWeek(db: Database.Database, weekStart: string): WeeklyPlan | undefined {
  const row = db.prepare("SELECT * FROM weekly_plan WHERE week_start = ?").get(weekStart) as PlanRow | undefined;
  if (!row) return undefined;
  const dinners = (
    db.prepare("SELECT * FROM planned_dinner WHERE plan_id = ? ORDER BY date").all(row.id) as DinnerRow[]
  ).map((d) => ({
    date: d.date,
    dishId: d.dish_id,
    isQuickDay: d.is_quick_day === 1,
    lunchThatDay: d.lunch_that_day,
    rationale: d.selection_rationale,
    sourceUrl: d.source_url,
  }));
  return {
    id: row.id,
    weekStart: row.week_start,
    generatedAt: row.generated_at,
    status: row.status,
    degradedReasons: JSON.parse(row.degraded_reasons) as string[],
    dinners,
  };
}

/** FR-9a: locks the week's plan from automatic changes. Returns false when there is no plan. */
export function confirmPlan(db: Database.Database, weekStart: string): boolean {
  return db.prepare("UPDATE weekly_plan SET status = 'confirmed' WHERE week_start = ?").run(weekStart).changes > 0;
}

/**
 * Variety Preference input (FR-7): every Dish planned in the `windowWeeks` weeks before
 * `beforeWeekStart`, with its most recent date. Most recent first.
 */
export function listRecentlyPlanned(
  db: Database.Database,
  beforeWeekStart: string,
  windowWeeks: number,
): RecentlyPlanned[] {
  const from = windowStart(beforeWeekStart, windowWeeks);
  const rows = db
    .prepare(
      `SELECT pd.dish_id AS dish_id, MAX(pd.date) AS last_date
       FROM planned_dinner pd JOIN weekly_plan wp ON wp.id = pd.plan_id
       WHERE pd.dish_id IS NOT NULL AND wp.week_start >= ? AND wp.week_start < ?
       GROUP BY pd.dish_id
       ORDER BY last_date DESC, pd.dish_id`,
    )
    .all(from, beforeWeekStart) as { dish_id: number; last_date: string }[];
  return rows.map((r) => ({ dishId: String(r.dish_id), lastDate: r.last_date }));
}

function windowStart(weekStart: string, windowWeeks: number): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7 * windowWeeks);
  return d.toISOString().slice(0, 10);
}
