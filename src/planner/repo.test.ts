import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db.js";
import { createDish, deleteDish } from "../dishes/repo.js";
import { confirmPlan, getPlanForWeek, listRecentlyPlanned, savePlan } from "./repo.js";
import type { PlanWeekResult } from "./plan-week.js";
import { datesOfWeek } from "./week.js";

function freshDb() {
  return openDatabase(mkdtempSync(join(tmpdir(), "planner-repo-")));
}

function plan(weekStart: string, dishIds: (number | null)[], degradedReasons: string[] = []): PlanWeekResult {
  return {
    weekStart,
    degradedReasons,
    dinners: datesOfWeek(weekStart).map((date, i) => ({
      date,
      dishId: dishIds[i] ?? null,
      isQuickDay: i === 1,
      lunchThatDay: i === 0 ? "Fiskgratäng" : null,
      rationale: `because ${i}`,
    })),
  };
}

describe("savePlan / getPlanForWeek", () => {
  it("stores one Planned Dinner per date with rationale and reads the week back", () => {
    const db = freshDb();
    const burgers = createDish(db, { name: "Burgers" });

    const id = savePlan(db, plan("2026-10-12", [burgers, null, burgers, burgers, burgers, burgers, burgers], ["x"]), "2026-10-11T18:00:00.000Z");
    const stored = getPlanForWeek(db, "2026-10-12");

    expect(stored).toMatchObject({
      id,
      weekStart: "2026-10-12",
      generatedAt: "2026-10-11T18:00:00.000Z",
      status: "generated",
      degradedReasons: ["x"],
    });
    expect(stored?.dinners).toHaveLength(7);
    expect(stored?.dinners[0]).toEqual({
      date: "2026-10-12",
      dishId: burgers,
      isQuickDay: false,
      lunchThatDay: "Fiskgratäng",
      rationale: "because 0",
      sourceUrl: null,
    });
    expect(stored?.dinners[1]).toMatchObject({ date: "2026-10-13", dishId: null, isQuickDay: true });
  });

  it("returns undefined for a week with no plan", () => {
    expect(getPlanForWeek(freshDb(), "2026-10-12")).toBeUndefined();
  });

  it("replaces an existing plan for the same week", () => {
    const db = freshDb();
    const a = createDish(db, { name: "A" });
    const b = createDish(db, { name: "B" });
    savePlan(db, plan("2026-10-12", [a, a, a, a, a, a, a]), "2026-10-11T18:00:00.000Z");

    savePlan(db, plan("2026-10-12", [b, b, b, b, b, b, b]), "2026-10-12T09:00:00.000Z");

    const stored = getPlanForWeek(db, "2026-10-12");
    expect(stored?.generatedAt).toBe("2026-10-12T09:00:00.000Z");
    expect(stored?.dinners.map((d) => d.dishId)).toEqual([b, b, b, b, b, b, b]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM planned_dinner").get()).toEqual({ n: 7 });
  });

  it("empties the dinner when its Dish is deleted", () => {
    const db = freshDb();
    const a = createDish(db, { name: "A" });
    savePlan(db, plan("2026-10-12", [a, a, a, a, a, a, a]), "2026-10-11T18:00:00.000Z");

    deleteDish(db, a);

    expect(getPlanForWeek(db, "2026-10-12")?.dinners.every((d) => d.dishId === null)).toBe(true);
  });
});

describe("confirmPlan", () => {
  it("flips status to confirmed (FR-9a)", () => {
    const db = freshDb();
    savePlan(db, plan("2026-10-12", []), "2026-10-11T18:00:00.000Z");

    expect(confirmPlan(db, "2026-10-12")).toBe(true);
    expect(getPlanForWeek(db, "2026-10-12")?.status).toBe("confirmed");
    expect(confirmPlan(db, "2026-10-19")).toBe(false);
  });
});

describe("listRecentlyPlanned", () => {
  it("returns each Dish planned within the window before the week, with its last date", () => {
    const db = freshDb();
    const a = createDish(db, { name: "A" });
    const b = createDish(db, { name: "B" });
    const c = createDish(db, { name: "C" });
    savePlan(db, plan("2026-09-14", [c, c, c, c, c, c, c]), "t"); // 4 weeks before: outside a 3-week window
    savePlan(db, plan("2026-09-21", [a, null, null, null, null, null, null]), "t");
    savePlan(db, plan("2026-10-05", [b, a, null, null, null, null, null]), "t");
    savePlan(db, plan("2026-10-12", [c, c, c, c, c, c, c]), "t"); // the week itself: not "before"

    const recent = listRecentlyPlanned(db, "2026-10-12", 3);

    expect(recent).toEqual([
      { dishId: String(a), lastDate: "2026-10-06" },
      { dishId: String(b), lastDate: "2026-10-05" },
    ]);
  });
});
