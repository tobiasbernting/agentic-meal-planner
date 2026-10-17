/**
 * Weekly Plan storage: one `weekly_plan` row per week (Monday) with its seven
 * `planned_dinner` rows. A Dish being deleted empties the dinner rather than the plan.
 */
import type Database from "better-sqlite3";
import type { PlanWeekResult, RecentlyPlanned } from "./plan-week.js";
import { parseDegradedReasons, toStored, type DegradedReason, type DegradedReasonDraft } from "./degraded.js";

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
  /** Per date (or the whole week) as reason codes; render with `describeDegraded`. */
  degradedReasons: DegradedReason[];
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
/** A Weekly Plan to store. Its reasons may be drafts (`detail` and log-only reasons are dropped) or stored codes. */
export interface PlanToSave extends Omit<PlanWeekResult, "degradedReasons"> {
  degradedReasons: (DegradedReason | DegradedReasonDraft)[];
}

export function savePlan(
  db: Database.Database,
  plan: PlanToSave,
  generatedAt: string,
): number {
  return db.transaction(() => {
    db.prepare("DELETE FROM weekly_plan WHERE week_start = ?").run(plan.weekStart);
    const result = db
      .prepare("INSERT INTO weekly_plan (week_start, generated_at, status, degraded_reasons) VALUES (?, ?, 'generated', ?)")
      .run(plan.weekStart, generatedAt, JSON.stringify(toStored(plan.degradedReasons)));
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
  return {
    id: row.id,
    weekStart: row.week_start,
    generatedAt: row.generated_at,
    status: row.status,
    degradedReasons: parseDegradedReasons(row.degraded_reasons),
    dinners: listPlannedDinners(db, row.id),
  };
}

/** The plan's Planned Dinners in date order; empty for an unknown plan id. */
export function listPlannedDinners(db: Database.Database, planId: number): PlannedDinner[] {
  return (db.prepare("SELECT * FROM planned_dinner WHERE plan_id = ? ORDER BY date").all(planId) as DinnerRow[]).map(
    (d) => ({
      date: d.date,
      dishId: d.dish_id,
      isQuickDay: d.is_quick_day === 1,
      lunchThatDay: d.lunch_that_day,
      rationale: d.selection_rationale,
      sourceUrl: d.source_url,
    }),
  );
}

/** FR-9a: locks the week's plan from automatic changes. Returns false when there is no plan. */
export function confirmPlan(db: Database.Database, weekStart: string): boolean {
  return db.prepare("UPDATE weekly_plan SET status = 'confirmed' WHERE week_start = ?").run(weekStart).changes > 0;
}

/**
 * Links a Planned Dinner to the recipe its Ingredients came from (ADR-0003: an LLM-found
 * recipe is less predictable, so a human can glance at the source). `null` clears it.
 * Returns false when the plan has no dinner on that date.
 */
export function setPlannedDinnerSource(
  db: Database.Database,
  planId: number,
  date: string,
  sourceUrl: string | null,
): boolean {
  return (
    db.prepare("UPDATE planned_dinner SET source_url = ? WHERE plan_id = ? AND date = ?").run(sourceUrl, planId, date)
      .changes > 0
  );
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
      `SELECT pd.dish_id AS dish_id, d.name AS name, MAX(pd.date) AS last_date
       FROM planned_dinner pd JOIN weekly_plan wp ON wp.id = pd.plan_id JOIN dish d ON d.id = pd.dish_id
       WHERE wp.week_start >= ? AND wp.week_start < ?
       GROUP BY pd.dish_id
       ORDER BY last_date DESC, pd.dish_id`,
    )
    .all(from, beforeWeekStart) as { dish_id: number; name: string; last_date: string }[];
  return rows.map((r) => ({ dishId: String(r.dish_id), name: r.name, lastDate: r.last_date }));
}

function windowStart(weekStart: string, windowWeeks: number): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7 * windowWeeks);
  return d.toISOString().slice(0, 10);
}

/** The week of a stored plan by id, `undefined` for an unknown id. */
export function getPlanById(db: Database.Database, planId: number): { weekStart: string } | undefined {
  const row = db.prepare("SELECT week_start FROM weekly_plan WHERE id = ?").get(planId) as { week_start: string } | undefined;
  return row ? { weekStart: row.week_start } : undefined;
}

/**
 * Swap (spec #71): puts `dishId` on the plan's dinner for `date` with `rationale`, and clears the
 * old Dish's recipe link and that date's degraded reasons (the household picked the Dish, so they
 * no longer describe it; week-wide reasons stay). Returns false when the plan has no dinner on that date.
 */
export function setPlannedDinnerDish(
  db: Database.Database,
  planId: number,
  date: string,
  dishId: number,
  rationale: string,
): boolean {
  return db.transaction(() => {
    const changed =
      db
        .prepare("UPDATE planned_dinner SET dish_id = ?, selection_rationale = ?, source_url = NULL WHERE plan_id = ? AND date = ?")
        .run(dishId, rationale, planId, date).changes > 0;
    if (!changed) return false;
    const row = db.prepare("SELECT degraded_reasons FROM weekly_plan WHERE id = ?").get(planId) as
      | { degraded_reasons: string }
      | undefined;
    if (row) {
      const kept = parseDegradedReasons(row.degraded_reasons).filter((r) => r.date !== date);
      db.prepare("UPDATE weekly_plan SET degraded_reasons = ? WHERE id = ?").run(JSON.stringify(kept), planId);
    }
    return true;
  })();
}

/** Every date `dishId` is planned for, in any week and any plan status, oldest first. */
export function listPlannedDatesForDish(db: Database.Database, dishId: number): string[] {
  return (db.prepare("SELECT date FROM planned_dinner WHERE dish_id = ? ORDER BY date").all(dishId) as { date: string }[]).map((r) => r.date);
}

/**
 * Before a Dish is deleted: empties its Planned Dinners in unconfirmed plans (the rationale,
 * recipe link and that date's degraded reasons described the Dish, so they go) so the day reads
 * as empty and offers a Swap. Confirmed plans are untouched. Runs in the caller's transaction,
 * with the Dish's delete.
 */
export function clearDishFromUnconfirmedPlans(db: Database.Database, dishId: number): void {
  const clearDay = db.prepare("UPDATE planned_dinner SET selection_rationale = '', source_url = NULL WHERE plan_id = ? AND date = ?");
  const readReasons = db.prepare("SELECT degraded_reasons FROM weekly_plan WHERE id = ?");
  const writeReasons = db.prepare("UPDATE weekly_plan SET degraded_reasons = ? WHERE id = ?");
  const days = db
    .prepare(
      `SELECT pd.plan_id AS plan_id, pd.date AS date FROM planned_dinner pd JOIN weekly_plan wp ON wp.id = pd.plan_id
       WHERE pd.dish_id = ? AND wp.status = 'generated'`,
    )
    .all(dishId) as { plan_id: number; date: string }[];
  for (const { plan_id, date } of days) {
    clearDay.run(plan_id, date);
    const row = readReasons.get(plan_id) as { degraded_reasons: string };
    const kept = parseDegradedReasons(row.degraded_reasons).filter((r) => r.date !== date);
    writeReasons.run(JSON.stringify(kept), plan_id);
  }
}
