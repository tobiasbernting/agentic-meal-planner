import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, writeSetting } from "../db.js";
import { createDish } from "../dishes/repo.js";
import { t } from "../i18n/index.js";
import { NO_AGENT_REASON, NoAgent, ScriptedLlmAgent, type SelectDishesInput } from "../llm/index.js";
import { upsertLunchEntry } from "../lunch/repo.js";
import { createSchool, setSchoolActive } from "../schools/repo.js";
import { generatePlan } from "./generate.js";
import { confirmPlan, getPlanForWeek, savePlan } from "./repo.js";
import { SETTING_QUICK_DAY_TEMPLATE } from "./settings.js";

const WEEK = "2026-10-12";
const NOW = "2026-10-11T18:00:00.000Z";

function freshDb() {
  return openDatabase(mkdtempSync(join(tmpdir(), "planner-generate-")));
}

describe("generatePlan", () => {
  it("plans the week from Favorite Dishes and stores one Planned Dinner per date with a rationale", async () => {
    const db = freshDb();
    const burgers = createDish(db, { name: "Burgers", prepTimeMinutes: 20 });
    createDish(db, { name: "Parked", inRotation: false });
    const llm = new ScriptedLlmAgent({
      selectDishes: (req) => ({
        ok: true,
        value: req.days.map((d) => ({ date: d.date, dishId: String(burgers), rationale: `burgers on ${d.date}` })),
      }),
    });

    const result = await generatePlan({ db, llm, now: () => NOW }, WEEK);

    expect(result).toEqual({ planId: expect.any(Number), degradedReasons: [] });
    const stored = getPlanForWeek(db, WEEK);
    expect(stored?.generatedAt).toBe(NOW);
    expect(stored?.dinners).toHaveLength(7);
    expect(stored?.dinners.every((d) => d.dishId === burgers && d.rationale.startsWith("burgers on "))).toBe(true);
    const req = llm.calls[0]?.args[0] as SelectDishesInput;
    expect(req.candidates.flat().map((d) => d.name)).not.toContain("Parked");
  });

  it("feeds settings, recent plans and loaded lunch into the planner", async () => {
    const db = freshDb();
    const fish = createDish(db, { name: "Fish", mainCategory: "fish", prepTimeMinutes: 20 });
    const stew = createDish(db, { name: "Stew", prepTimeMinutes: 90 });
    writeSetting(db, SETTING_QUICK_DAY_TEMPLATE, '{"wed":30}');
    savePlan(
      db,
      { weekStart: "2026-10-05", degradedReasons: [], dinners: [{ date: "2026-10-05", dishId: stew, isQuickDay: false, lunchThatDay: null, rationale: "r" }] },
      NOW,
    );
    const llm = new ScriptedLlmAgent({ selectDishes: { ok: true, value: [] } });
    const lunch = { "2026-10-12": [{ date: "2026-10-12", rawText: "Fiskpinnar", mainCategory: "fish" }] };

    await generatePlan({ db, llm, now: () => NOW, loadLunch: () => lunch }, WEEK);

    const req = llm.calls[0]?.args[0] as SelectDishesInput;
    expect(req.candidates[0]?.map((d) => d.name)).toEqual(["Stew"]); // Monday: fish collides with lunch
    expect(req.days[2]?.isQuickDay).toBe(true);
    expect(req.candidates[2]?.map((d) => d.name)).toEqual(["Fish"]); // Wednesday: Stew too slow
    expect(req.recentlyPlanned).toEqual([{ dishId: String(stew), name: "Stew", lastDate: "2026-10-05" }]);
    expect(getPlanForWeek(db, WEEK)?.dinners[0]?.lunchThatDay).toBe("Fiskpinnar");
    expect(fish).toBeGreaterThan(0);
  });

  it("loads stored Lunch Entries of active Schools by default so lunch constrains dinner", async () => {
    const db = freshDb();
    createDish(db, { name: "Fish", mainCategory: "fish", prepTimeMinutes: 20 });
    createDish(db, { name: "Stew", prepTimeMinutes: 20 });
    const school = createSchool(db, { name: "Skolan", url: "https://example.test/menu" });
    const paused = createSchool(db, { name: "Paused", url: "https://example.test/paused" });
    setSchoolActive(db, paused.id, false);
    upsertLunchEntry(db, { schoolId: school.id, date: "2026-10-12", rawText: "Fiskpinnar\nSallad", mainCategory: "fish", fetchedAt: NOW });
    upsertLunchEntry(db, { schoolId: school.id, date: "2026-10-11", rawText: "Last week", mainCategory: "fish", fetchedAt: NOW });
    upsertLunchEntry(db, { schoolId: paused.id, date: "2026-10-13", rawText: "Paused fish", mainCategory: "fish", fetchedAt: NOW });
    const llm = new ScriptedLlmAgent({ selectDishes: { ok: true, value: [] } });

    await generatePlan({ db, llm, now: () => NOW }, WEEK);

    const req = llm.calls[0]?.args[0] as SelectDishesInput;
    expect(req.days[0]?.lunch).toEqual([{ date: "2026-10-12", rawText: "Fiskpinnar\nSallad", mainCategory: "fish" }]);
    expect(req.candidates[0]?.map((d) => d.name)).toEqual(["Stew"]); // Monday: fish collides with the stored lunch
    expect(req.days[1]?.lunch).toEqual([]); // paused School does not constrain
    expect(req.candidates[1]?.map((d) => d.name)).toEqual(["Fish", "Stew"]);
    expect(getPlanForWeek(db, WEEK)?.dinners[0]?.lunchThatDay).toBe("Fiskpinnar\nSallad");
  });

  it("degrades with NoAgent: a plan is still stored and marked", async () => {
    const db = freshDb();
    createDish(db, { name: "A", prepTimeMinutes: 20 });
    createDish(db, { name: "B", prepTimeMinutes: 20 });

    const result = await generatePlan({ db, llm: new NoAgent(), now: () => NOW }, WEEK);

    expect(result).toEqual({ planId: expect.any(Number), degradedReasons: [NO_AGENT_REASON] });
    const stored = getPlanForWeek(db, WEEK);
    expect(stored?.degradedReasons).toEqual([{ code: "no-agent", date: null }]);
    expect(stored?.dinners.every((d) => d.dishId !== null && d.rationale === t("sv", "rationale.noAgent"))).toBe(true);
  });

  it("does not replace a confirmed plan unless asked (FR-9a)", async () => {
    const db = freshDb();
    const a = createDish(db, { name: "A", prepTimeMinutes: 20 });
    await generatePlan({ db, llm: new NoAgent(), now: () => NOW }, WEEK);
    confirmPlan(db, WEEK);
    createDish(db, { name: "B", prepTimeMinutes: 20 });

    const skipped = await generatePlan({ db, llm: new NoAgent(), now: () => "2026-10-12T00:00:00.000Z" }, WEEK);

    expect(skipped).toEqual({ skipped: "confirmed" });
    expect(getPlanForWeek(db, WEEK)).toMatchObject({ status: "confirmed", generatedAt: NOW });
    expect(getPlanForWeek(db, WEEK)?.dinners.every((d) => d.dishId === a)).toBe(true);

    const replaced = await generatePlan({ db, llm: new NoAgent(), now: () => "2026-10-12T00:00:00.000Z" }, WEEK, { replace: true });

    expect(replaced).toMatchObject({ planId: expect.any(Number) });
    expect(getPlanForWeek(db, WEEK)).toMatchObject({ status: "generated", generatedAt: "2026-10-12T00:00:00.000Z" });
  });

  it("replaces a generated (unconfirmed) plan without being asked", async () => {
    const db = freshDb();
    createDish(db, { name: "A" });
    await generatePlan({ db, llm: new NoAgent(), now: () => NOW }, WEEK);

    await generatePlan({ db, llm: new NoAgent(), now: () => "2026-10-12T00:00:00.000Z" }, WEEK);

    expect(getPlanForWeek(db, WEEK)?.generatedAt).toBe("2026-10-12T00:00:00.000Z");
  });
});
