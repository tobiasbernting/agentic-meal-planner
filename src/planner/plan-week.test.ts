import { describe, expect, it } from "vitest";
import type { Dish } from "../dishes/repo.js";
import {
  NO_AGENT_REASON,
  NoAgent,
  ScriptedLlmAgent,
  SEED_DISHES,
  type DishSuggestion,
  type SelectDishesInput,
} from "../llm/index.js";
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

  it("sends the suggestion style from settings to the LLM", async () => {
    const llm = new ScriptedLlmAgent({ selectDishes: { ok: true, value: [] } });
    await planWeek(input({ settings: { ...DEFAULT_PLANNER_SETTINGS, suggestionStyle: "vegetarian weeknight food" }, llm }));
    const req = llm.calls[0]?.args[0] as SelectDishesInput;
    expect(req.suggestionStyle).toBe("vegetarian weeknight food");
  });

  it("leaves a day empty, with a rationale asking for a manual pick, when neither a Dish nor a seed dish is eligible", async () => {
    const roast = dish({ name: "Roast", weekendOnly: true });
    // Every weekday lunch collides with every seed dish: one entry per Main Category, plus Pannkakor by name.
    const categories = ["pasta", "rice", "potatoes", "fish", "chicken", "beef", "pork", "vegetarian", "soup", "tacos"];
    const lunchByDate = Object.fromEntries(
      ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map((date) => [
        date,
        [
          ...categories.map((mainCategory) => ({ date, rawText: `lunch ${mainCategory}`, mainCategory })),
          { date, rawText: "Pannkakor" },
        ],
      ]),
    );
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

    const result = await planWeek(input({ dishes: [roast], lunchByDate, llm }));

    expect(result.dinners).toHaveLength(7);
    for (const dinner of result.dinners.slice(0, 5)) {
      expect(dinner.dishId).toBeNull();
      expect(dinner.suggestion).toBeNull();
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

  describe("Suggested Dishes", () => {
    function suggesting(
      suggest: (req: SelectDishesInput, date: string, i: number) => DishSuggestion | undefined,
      rationale = "scripted suggestion",
    ) {
      return new ScriptedLlmAgent({
        selectDishes: (req) => ({
          ok: true,
          value: req.days.flatMap((day, i) => {
            const suggestion = suggest(req, day.date, i);
            return suggestion ? [{ date: day.date, suggestion, rationale: `${rationale} ${day.date}` }] : [];
          }),
        }),
      });
    }

    it("fills every date with the agent's suggestion when there are no Dishes", async () => {
      const llm = suggesting(() => ({ name: "Kalops", mainCategory: "beef", prepTimeMinutes: 90 }));

      const result = await planWeek(input({ dishes: [], llm }));

      for (const dinner of result.dinners) {
        expect(dinner.dishId).toBeNull();
        expect(dinner.suggestion).toEqual({ name: "Kalops", mainCategory: "beef", prepTimeMinutes: 90 });
        expect(dinner.rationale).toBe(`scripted suggestion ${dinner.date}`);
      }
      expect(result.degradedReasons).toEqual([]);
    });

    it("suggests only on a date where every Favorite Dish is excluded, and drops a suggestion for a date with candidates", async () => {
      const fishSticks = dish({ name: "Fiskpinnar", mainCategory: "fish" });
      const lunch = { "2026-10-14": [{ date: "2026-10-14", rawText: "Fiskgratäng", mainCategory: "fish" }] };
      const llm = new ScriptedLlmAgent({
        selectDishes: (req) => ({
          ok: true,
          value: req.days.map((day) => ({
            date: day.date,
            suggestion: { name: "Kalops", mainCategory: "beef", prepTimeMinutes: 90 },
            rationale: "suggested",
          })),
        }),
      });

      const result = await planWeek(input({ dishes: [fishSticks], lunchByDate: lunch, llm }));

      expect(result.dinners[2]).toMatchObject({
        dishId: null,
        suggestion: { name: "Kalops", mainCategory: "beef", prepTimeMinutes: 90 },
        rationale: "suggested",
      });
      for (const dinner of result.dinners.filter((_, i) => i !== 2)) {
        expect(dinner).toMatchObject({ dishId: null, suggestion: null });
        expect(dinner.rationale).toMatch(/dropped/);
      }
      expect(result.degradedReasons).toHaveLength(6);
      expect(result.degradedReasons[0]).toMatch(/^2026-10-12: /);
    });

    describe("drops a suggestion that breaks a hard rule or is malformed, and falls back to the seed list", () => {
      const monday = "2026-10-12";
      const tuesday = "2026-10-13";
      const onlyOn = (date: string, suggestion: unknown) =>
        new ScriptedLlmAgent({
          selectDishes: { ok: true, value: [{ date, suggestion: suggestion as DishSuggestion, rationale: "agent" }] },
        });

      it.each([
        ["same name as lunch", monday, { name: "  köttbullar  ", mainCategory: "other", prepTimeMinutes: 20 }, /same dish as lunch/],
        ["same Main Category as lunch", monday, { name: "Biff", mainCategory: "beef", prepTimeMinutes: 20 }, /Main Category/],
        ["over the Quick Day limit", tuesday, { name: "Kalops", mainCategory: "other", prepTimeMinutes: 90 }, /Quick Day/],
        ["no prep time on a Quick Day", tuesday, { name: "Kalops", mainCategory: "other" }, /prep time is unknown/],
        ["empty name", monday, { name: "  ", mainCategory: "other" }, /name/],
        ["unknown Main Category", monday, { name: "Kalops", mainCategory: "stew" }, /Main Category/],
        ["non-integer prep time", monday, { name: "Kalops", mainCategory: "other", prepTimeMinutes: 12.5 }, /prep time/],
        ["zero prep time", monday, { name: "Kalops", mainCategory: "other", prepTimeMinutes: 0 }, /prep time/],
      ])("%s", async (_label, date, suggestion, why) => {
        const lunch = { [monday]: [{ date: monday, rawText: "Köttbullar", mainCategory: "beef" }] };
        const settings = { ...DEFAULT_PLANNER_SETTINGS, quickDayTemplate: { tue: 30 } };

        const result = await planWeek(input({ dishes: [], lunchByDate: lunch, settings, llm: onlyOn(date, suggestion) }));

        const dinner = result.dinners.find((d) => d.date === date)!;
        expect(dinner.suggestion).not.toBeNull();
        expect(dinner.suggestion?.name).not.toBe((suggestion as DishSuggestion).name);
        const dropped = result.degradedReasons.find((r) => r.startsWith(`${date}: suggestion `));
        expect(dropped).toMatch(/ dropped: /);
        expect(dropped).toMatch(why);
        expect(result.degradedReasons).toContain(`${date}: seed fallback used`);
      });
    });

    it("reuses an existing out-of-rotation Dish whose name matches the suggestion", async () => {
      const shelved = dish({ name: "Kalops", mainCategory: "beef", prepTimeMinutes: 90, inRotation: false });
      const llm = suggesting(() => ({ name: " KALOPS ", mainCategory: "beef", prepTimeMinutes: 80 }));

      const result = await planWeek(input({ dishes: [shelved], llm }));

      for (const dinner of result.dinners) {
        expect(dinner).toMatchObject({ dishId: shelved.id, suggestion: null, rationale: `scripted suggestion ${dinner.date}` });
      }
      expect(result.degradedReasons).toEqual([]);
    });

    it("drops a suggestion matching a Favorite Dish the filter excluded that day", async () => {
      const fishSticks = dish({ name: "Fiskpinnar", mainCategory: "fish" });
      const lunch = { "2026-10-12": [{ date: "2026-10-12", rawText: "Fiskgratäng", mainCategory: "fish" }] };
      const llm = new ScriptedLlmAgent({
        selectDishes: {
          ok: true,
          value: [{ date: "2026-10-12", suggestion: { name: "fiskpinnar", mainCategory: "other", prepTimeMinutes: 20 }, rationale: "x" }],
        },
      });

      const result = await planWeek(input({ dishes: [fishSticks], lunchByDate: lunch, llm }));

      expect(result.dinners[0]?.dishId).toBeNull();
      expect(result.dinners[0]?.suggestion?.name).not.toMatch(/fiskpinnar/i);
      expect(result.degradedReasons[0]).toMatch(/^2026-10-12: suggestion "fiskpinnar" dropped: .*Favorite Dish "Fiskpinnar"/);
      expect(result.degradedReasons).toContain("2026-10-12: seed fallback used");
    });

    it("hands the agent the seed list as inspiration", async () => {
      const llm = new ScriptedLlmAgent({ selectDishes: { ok: true, value: [] } });

      await planWeek(input({ llm }));

      const req = llm.calls[0]?.args[0] as SelectDishesInput;
      expect(req.seedDishes).toEqual(SEED_DISHES);
    });

    it("fills empty dates from the seed list under the hard filter, round-robin, with NoAgent", async () => {
      const lunch = { "2026-10-12": [{ date: "2026-10-12", rawText: "Köttbullar med potatismos", mainCategory: "pasta" }] };
      const settings = { ...DEFAULT_PLANNER_SETTINGS, quickDayTemplate: { tue: 20 } };

      const result = await planWeek(input({ dishes: [], lunchByDate: lunch, settings, llm: new NoAgent() }));

      const names = result.dinners.map((d) => d.suggestion?.name);
      // Monday: lunch is the first seed by name and the second by Main Category (pasta).
      // Tuesday: Quick Day (20 min), only "Falukorv med makaroner" (20) and "Omelett med sallad" (15) fit.
      expect(names).toEqual([
        "Pannkakor",
        "Falukorv med makaroner",
        "Lax i ugn med potatis",
        "Pytt i panna",
        "Kycklingnuggets med pommes",
        "Vegetarisk lasagne",
        "Tomatsoppa med bröd",
      ]);
      expect(result.dinners.every((d) => d.dishId === null)).toBe(true);
      expect(result.dinners[1]?.suggestion).toEqual({ name: "Falukorv med makaroner", mainCategory: "pork", prepTimeMinutes: 20 });
      expect(result.degradedReasons).toEqual([
        NO_AGENT_REASON,
        ...result.dinners.map((d) => `${d.date}: seed fallback used`),
      ]);
    });
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
