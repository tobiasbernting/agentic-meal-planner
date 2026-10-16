import { describe, expect, it } from "vitest";
import type { Dish } from "../dishes/repo.js";
import { NO_AGENT_REASON, NoAgent, ScriptedLlmAgent, type SelectDishesInput } from "../llm/index.js";
import { planWeek, NO_ELIGIBLE_DISH_RATIONALE, type PlanWeekInput } from "./plan-week.js";
import { DEFAULT_PLANNER_SETTINGS, type PlannerSettings } from "./settings.js";

const WEEK = "2026-10-12"; // Monday

let nextId = 1;
function dish(overrides: Partial<Dish> & { name: string }): Dish {
  return {
    id: nextId++,
    recipeUrl: null,
    adaptationNotes: null,
    prepTimeMinutes: 20,
    mainCategory: null,
    inRotation: true,
    preferredDays: [],
    weekendOnly: false,
    ingredients: [],
    ...overrides,
  };
}

const noQuickDays: PlannerSettings = { ...DEFAULT_PLANNER_SETTINGS, quickDayTemplate: {} };

function input(overrides: Partial<PlanWeekInput> = {}): PlanWeekInput {
  return {
    weekStart: WEEK,
    dishes: [dish({ name: "Burgers" }), dish({ name: "Pasta" }), dish({ name: "Soup" })],
    lunchByDate: {},
    settings: noQuickDays,
    recentlyPlanned: [],
    llm: new NoAgent(),
    ...overrides,
  };
}

describe("planWeek", () => {
  it("stores the LLM's pick and rationale for each of the seven dates", async () => {
    const [burgers, pasta] = input().dishes as [Dish, Dish];
    const llm = new ScriptedLlmAgent({
      selectDishes: (req) => ({
        ok: true,
        value: req.days.map((day, i) => ({
          date: day.date,
          dishId: String(i % 2 === 0 ? burgers.id : pasta.id),
          rationale: `scripted pick for ${day.date}`,
        })),
      }),
    });

    const result = await planWeek(input({ dishes: [burgers, pasta], llm }));

    expect(result.weekStart).toBe(WEEK);
    expect(result.dinners.map((d) => d.date)).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ]);
    expect(result.dinners.map((d) => d.dishId)).toEqual([
      burgers.id,
      pasta.id,
      burgers.id,
      pasta.id,
      burgers.id,
      pasta.id,
      burgers.id,
    ]);
    expect(result.dinners[0]?.rationale).toBe("scripted pick for 2026-10-12");
    expect(result.degradedReasons).toEqual([]);
  });

  it("hands the LLM the filtered candidates, Quick Day flags, lunch and recent plans", async () => {
    const weekendDish = dish({ name: "Roast", weekendOnly: true, prepTimeMinutes: 120 });
    const quick = dish({ name: "Omelette", prepTimeMinutes: 10, preferredDays: ["tue"] });
    const slow = dish({ name: "Stew", prepTimeMinutes: 90 });
    const llm = new ScriptedLlmAgent({ selectDishes: { ok: true, value: [] } });
    const lunch = { "2026-10-14": [{ date: "2026-10-14", rawText: "Stew", mainCategory: "beef" }] };
    const recentlyPlanned = [{ dishId: String(slow.id), lastDate: "2026-10-07" }];

    await planWeek(
      input({
        dishes: [weekendDish, quick, slow],
        lunchByDate: lunch,
        settings: { ...DEFAULT_PLANNER_SETTINGS, quickDayTemplate: { tue: 30 } },
        recentlyPlanned,
        llm,
      }),
    );

    const req = llm.calls[0]?.args[0] as SelectDishesInput;
    expect(req.days.map((d) => d.isQuickDay)).toEqual([false, true, false, false, false, false, false]);
    expect(req.days[2]?.lunch).toEqual(lunch["2026-10-14"]);
    expect(req.recentlyPlanned).toEqual(recentlyPlanned);
    const names = req.candidates.map((c) => c.map((d) => d.name));
    expect(names[0]).toEqual(["Omelette", "Stew"]); // Monday: no Weekend Dish
    expect(names[1]).toEqual(["Omelette"]); // Tuesday is a Quick Day (30 min)
    expect(names[2]).toEqual(["Omelette"]); // Wednesday: lunch is Stew
    expect(names[5]).toEqual(["Roast", "Omelette", "Stew"]); // Saturday
    expect(req.candidates[1]?.[0]).toMatchObject({ preferredDays: ["tue"] });
  });

  it("leaves a day with no eligible Dish empty, with a rationale asking for a manual pick", async () => {
    const roast = dish({ name: "Roast", weekendOnly: true });
    const llm = new ScriptedLlmAgent({
      selectDishes: (req) => ({
        ok: true,
        value: req.days.filter((_, i) => req.candidates[i]!.length > 0).map((day) => ({
          date: day.date,
          dishId: String(roast.id),
          rationale: "weekend",
        })),
      }),
    });

    const result = await planWeek(input({ dishes: [roast], llm }));

    expect(result.dinners).toHaveLength(7);
    for (const dinner of result.dinners.slice(0, 5)) {
      expect(dinner.dishId).toBeNull();
      expect(dinner.rationale).toBe(NO_ELIGIBLE_DISH_RATIONALE);
    }
    expect(result.dinners[5]).toMatchObject({ dishId: roast.id, rationale: "weekend" });
    expect(result.dinners[6]).toMatchObject({ dishId: roast.id, rationale: "weekend" });
    expect(result.degradedReasons).toEqual([]);
  });

  it("drops a pick that is not in that day's candidate set and marks the plan degraded", async () => {
    const roast = dish({ name: "Roast", weekendOnly: true });
    const pasta = dish({ name: "Pasta" });
    const llm = new ScriptedLlmAgent({
      selectDishes: (req) => ({
        ok: true,
        value: req.days.map((day) => ({ date: day.date, dishId: String(roast.id), rationale: "always roast" })),
      }),
    });

    const result = await planWeek(input({ dishes: [roast, pasta], llm }));

    expect(result.dinners[0]).toMatchObject({ date: "2026-10-12", dishId: null });
    expect(result.dinners[0]?.rationale).toMatch(/not eligible|dropped/i);
    expect(result.dinners[5]).toMatchObject({ dishId: roast.id, rationale: "always roast" });
    expect(result.degradedReasons.length).toBeGreaterThan(0);
    expect(result.degradedReasons[0]).toMatch(/2026-10-12/);
  });

  it("records the lunch of the day on each Planned Dinner", async () => {
    const lunch = {
      "2026-10-13": [
        { date: "2026-10-13", rawText: "Fiskgratäng" },
        { date: "2026-10-13", rawText: "Pannkakor" },
      ],
    };

    const result = await planWeek(input({ lunchByDate: lunch }));

    expect(result.dinners[0]?.lunchThatDay).toBeNull();
    expect(result.dinners[1]?.lunchThatDay).toBe("Fiskgratäng; Pannkakor");
  });

  it("marks Quick Days on the Planned Dinner", async () => {
    const result = await planWeek(input({ settings: { ...DEFAULT_PLANNER_SETTINGS, quickDayTemplate: { thu: 30 } } }));

    expect(result.dinners.map((d) => d.isQuickDay)).toEqual([false, false, false, true, false, false, false]);
  });

  describe("degraded path (FR-16)", () => {
    it("still plans round-robin with NoAgent and says no agent is configured", async () => {
      const result = await planWeek(input({ llm: new NoAgent() }));

      expect(result.dinners).toHaveLength(7);
      for (const dinner of result.dinners) {
        expect(dinner.dishId).not.toBeNull();
        expect(dinner.rationale).toBe(NO_AGENT_REASON);
      }
      expect(new Set(result.dinners.map((d) => d.dishId)).size).toBe(3);
      expect(result.degradedReasons).toEqual([NO_AGENT_REASON]);
    });

    it("falls back to round-robin when the agent fails", async () => {
      const llm = new ScriptedLlmAgent({ selectDishes: { ok: false, reason: "agent exited with code 1" } });

      const result = await planWeek(input({ llm }));

      expect(result.dinners.every((d) => d.dishId !== null)).toBe(true);
      expect(result.degradedReasons).toEqual(["agent exited with code 1"]);
    });
  });
});
