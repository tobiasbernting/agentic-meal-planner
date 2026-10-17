import { describe, expect, it } from "vitest";
import type { Dish } from "../dishes/repo.js";
import { CliAgent } from "../llm/cli-agent.js";
import {
  NO_AGENT_REASON,
  NoAgent,
  ScriptedLlmAgent,
  SEED_DISHES,
  type DishSuggestion,
  type SelectDishesInput,
} from "../llm/index.js";
import { planWeek, type PlanWeekInput, type PlanWeekResult } from "./plan-week.js";
import { t } from "../i18n/index.js";

/** The raw technical text of each degraded reason, as Logs get it. */
const details = (result: PlanWeekResult) => result.degradedReasons.map((r) => r.detail);
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
    const dishes = ["Burgers", "Pasta", "Soup", "Tacos", "Curry", "Stew", "Pie"].map((name) => dish({ name }));
    const llm = new ScriptedLlmAgent({
      selectDishes: (req) => ({
        ok: true,
        value: req.days.map((day, i) => ({
          date: day.date,
          dishId: String(dishes[i]!.id),
          rationale: `scripted pick for ${day.date}`,
        })),
      }),
    });

    const result = await planWeek(input({ dishes, llm }));

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
    expect(result.dinners.map((d) => d.dishId)).toEqual(dishes.map((d) => d.id));
    expect(result.dinners[0]?.rationale).toBe("scripted pick for 2026-10-12");
    expect(details(result)).toEqual([]);
  });

  it("hands the LLM the filtered candidates, Quick Day flags, lunch and recent plans", async () => {
    const weekendDish = dish({ name: "Roast", weekendOnly: true, prepTimeMinutes: 120 });
    const quick = dish({ name: "Omelette", prepTimeMinutes: 10, preferredDays: ["tue"] });
    const slow = dish({ name: "Stew", prepTimeMinutes: 90 });
    const llm = new ScriptedLlmAgent({ selectDishes: { ok: true, value: [] } });
    const lunch = { "2026-10-14": [{ date: "2026-10-14", rawText: "Stew", mainCategory: "beef" }] };
    const recentlyPlanned = [{ dishId: String(slow.id), name: "Stew", lastDate: "2026-10-07" }];

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
    const ribs = dish({ name: "Ribs", weekendOnly: true });
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
          dishId: String(day.date === "2026-10-17" ? roast.id : ribs.id),
          rationale: "weekend",
        })),
      }),
    });

    const result = await planWeek(input({ dishes: [roast, ribs], lunchByDate, llm }));

    expect(result.dinners).toHaveLength(7);
    for (const dinner of result.dinners.slice(0, 5)) {
      expect(dinner.dishId).toBeNull();
      expect(dinner.suggestion).toBeNull();
      expect(dinner.rationale).toBe("Ingen lämplig rätt, välj en.");
    }
    expect(result.dinners[5]).toMatchObject({ dishId: roast.id, rationale: "weekend" });
    expect(result.dinners[6]).toMatchObject({ dishId: ribs.id, rationale: "weekend" });
    expect(details(result)).toEqual([]);
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
    expect(result.dinners[0]?.rationale).toBe(t("sv", "rationale.pickDropped"));
    expect(result.degradedReasons[0]).toMatchObject({ code: "pick-not-eligible", date: "2026-10-12" });
    expect(result.dinners[5]).toMatchObject({ dishId: roast.id, rationale: "always roast" });
    expect(details(result).length).toBeGreaterThan(0);
    expect(details(result)[0]).toMatch(/2026-10-12/);
  });

  it("keeps a Dish the agent picks twice on its first date only (Once a Week); the second date gets a seed fallback", async () => {
    const dishes = ["Burgers", "Pasta", "Soup", "Tacos", "Curry", "Stew", "Pie"].map((name) => dish({ name }));
    const [burgers] = dishes as [Dish];
    const llm = new ScriptedLlmAgent({
      selectDishes: (req) => ({
        ok: true,
        value: req.days.map((day, i) => ({ date: day.date, dishId: String(i === 1 ? burgers.id : dishes[i]!.id), rationale: `pick ${i}` })),
      }),
    });

    const result = await planWeek(input({ dishes, llm }));

    expect(result.dinners[0]).toMatchObject({ dishId: burgers.id, rationale: "pick 0" });
    expect(result.dinners[1]).toMatchObject({ dishId: null, suggestion: { name: SEED_DISHES[0]!.name }, rationale: t("sv", "rationale.seedFallback") });
    expect(result.dinners.filter((d) => d.dishId === burgers.id)).toHaveLength(1);
    expect(result.degradedReasons.filter((r) => !r.logOnly)).toEqual([
      expect.objectContaining({ code: "once-a-week", date: "2026-10-13", params: { name: "Burgers" } }),
    ]);
  });

  it("keeps the agent's same-Main-Category picks on consecutive dinners, with its rationale (Variety Preference is soft)", async () => {
    const salmon = dish({ name: "Lax", mainCategory: "fish" });
    const cod = dish({ name: "Torsk", mainCategory: "fish" });
    const llm = new ScriptedLlmAgent({
      selectDishes: {
        ok: true,
        value: [
          { date: "2026-10-12", dishId: String(salmon.id), rationale: "Lax while it is fresh" },
          { date: "2026-10-13", dishId: String(cod.id), rationale: "Fish again: the torsk must be eaten before Wednesday" },
        ],
      },
    });

    const result = await planWeek(input({ dishes: [salmon, cod], llm }));

    expect(result.dinners.slice(0, 2)).toMatchObject([
      { dishId: salmon.id, rationale: "Lax while it is fresh" },
      { dishId: cod.id, rationale: "Fish again: the torsk must be eaten before Wednesday" },
    ]);
    expect(result.degradedReasons.filter((r) => r.date === "2026-10-13")).toEqual([]);
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
      const llm = suggesting((_req, _date, i) => ({ name: `Kalops ${i}`, mainCategory: "beef", prepTimeMinutes: 90 }));

      const result = await planWeek(input({ dishes: [], llm }));

      for (const [i, dinner] of result.dinners.entries()) {
        expect(dinner.dishId).toBeNull();
        expect(dinner.suggestion).toEqual({ name: `Kalops ${i}`, mainCategory: "beef", prepTimeMinutes: 90 });
        expect(dinner.rationale).toBe(`scripted suggestion ${dinner.date}`);
      }
      expect(details(result)).toEqual([]);
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
        expect(dinner.rationale).toBe(t("sv", "rationale.pickDropped"));
      }
      expect(details(result)).toHaveLength(6);
      expect(details(result)[0]).toMatch(/^2026-10-12: /);
    });

    describe("drops a suggestion that breaks a hard rule or is malformed, and falls back to the seed list", () => {
      const monday = "2026-10-12";
      const tuesday = "2026-10-13";
      const onlyOn = (date: string, suggestion: unknown) =>
        new ScriptedLlmAgent({
          selectDishes: { ok: true, value: [{ date, suggestion: suggestion as DishSuggestion, rationale: "agent" }] },
        });

      it.each([
        ["same name as lunch", monday, { name: "  köttbullar  ", mainCategory: "other", prepTimeMinutes: 20 }, /same dish as lunch/, "same-as-lunch"],
        ["same Main Category as lunch", monday, { name: "Biff", mainCategory: "beef", prepTimeMinutes: 20 }, /Main Category/, "lunch-category"],
        ["over the Quick Day limit", tuesday, { name: "Kalops", mainCategory: "other", prepTimeMinutes: 90 }, /Quick Day/, "quick-day"],
        ["no prep time on a Quick Day", tuesday, { name: "Kalops", mainCategory: "other" }, /prep time is unknown/, "quick-day"],
        ["empty name", monday, { name: "  ", mainCategory: "other" }, /name/, "suggestion-invalid"],
        ["unknown Main Category", monday, { name: "Kalops", mainCategory: "stew" }, /Main Category/, "suggestion-invalid"],
        ["non-integer prep time", monday, { name: "Kalops", mainCategory: "other", prepTimeMinutes: 12.5 }, /prep time/, "suggestion-invalid"],
        ["zero prep time", monday, { name: "Kalops", mainCategory: "other", prepTimeMinutes: 0 }, /prep time/, "suggestion-invalid"],
      ])("%s", async (_label, date, suggestion, why, code) => {
        const lunch = { [monday]: [{ date: monday, rawText: "Köttbullar", mainCategory: "beef" }] };
        const settings = { ...DEFAULT_PLANNER_SETTINGS, quickDayTemplate: { tue: 30 } };

        const result = await planWeek(input({ dishes: [], lunchByDate: lunch, settings, llm: onlyOn(date, suggestion) }));

        const dinner = result.dinners.find((d) => d.date === date)!;
        expect(dinner.suggestion).not.toBeNull();
        expect(dinner.suggestion?.name).not.toBe((suggestion as DishSuggestion).name);
        const dropped = details(result).find((r) => r.startsWith(`${date}: suggestion `));
        expect(dropped).toMatch(/ dropped: /);
        expect(dropped).toMatch(why);
        expect(details(result)).toContain(`${date}: seed fallback used`);
        // One household reason per day: the drop explains it, the seed fallback only reaches Logs.
        expect(result.degradedReasons.filter((r) => r.date === date && !r.logOnly)).toEqual([
          expect.objectContaining({ code, date, params: expect.objectContaining({ name: (suggestion as DishSuggestion).name }) }),
        ]);
      });
    });

    it("keeps six agent picks and drops only the malformed suggestion from a CLI agent reply", async () => {
      const pastas = [1, 2, 3, 4, 5, 6].map((n) => dish({ name: `Pasta ${n}`, mainCategory: "pasta" }));
      const lunch = { "2026-10-12": [{ date: "2026-10-12", rawText: "Spagetti", mainCategory: "pasta" }] };
      const reply = [
        { date: "2026-10-12", suggestion: { name: "Sushi", mainCategory: "sushi" }, rationale: "new" },
        ...["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"].map((date, i) => ({
          date,
          dishId: pastas[i]!.id,
          rationale: "favorite",
        })),
      ];
      const llm = new CliAgent("agent -p", {
        run: async () => ({ stdout: JSON.stringify(reply), stderr: "", exitCode: 0 }),
      });

      const result = await planWeek(input({ dishes: pastas, lunchByDate: lunch, llm }));

      expect(result.dinners.slice(1).map((d) => d.dishId)).toEqual(pastas.map((d) => d.id));
      expect(result.dinners.slice(1).every((d) => d.rationale === "favorite")).toBe(true);
      expect(result.dinners[0]?.suggestion?.name).not.toBe("Sushi");
      expect(details(result)[0]).toMatch(/^2026-10-12: suggestion "Sushi" dropped: Main Category "sushi"/);
      expect(details(result)).toContain("2026-10-12: seed fallback used");
    });

    it("reuses an existing out-of-rotation Dish whose name matches the suggestion, once a week", async () => {
      const shelved = dish({ name: "Kalops", mainCategory: "beef", prepTimeMinutes: 90, inRotation: false });
      const llm = suggesting(() => ({ name: " KALOPS ", mainCategory: "beef", prepTimeMinutes: 80 }));

      const result = await planWeek(input({ dishes: [shelved], llm }));

      expect(result.dinners[0]).toMatchObject({ dishId: shelved.id, suggestion: null, rationale: "scripted suggestion 2026-10-12" });
      expect(result.dinners.filter((d) => d.dishId === shelved.id)).toHaveLength(1);
      expect(result.degradedReasons.find((r) => r.date === "2026-10-13" && !r.logOnly)).toMatchObject({ code: "once-a-week" });
    });

    it("hands the agent every Favorite and Suggested Dish by id and name, and each day's Quick Day limit", async () => {
      const favorite = dish({ name: "Tacos", mainCategory: "tacos", weekendOnly: true });
      const suggested = dish({ name: "Ärtsoppa", mainCategory: "soup", inRotation: false, suggested: true });
      const shelved = dish({ name: "Gammal gryta", inRotation: false, suggested: false });
      const llm = new ScriptedLlmAgent({ selectDishes: { ok: true, value: [] } });

      await planWeek(input({ dishes: [favorite, suggested, shelved], settings: { ...DEFAULT_PLANNER_SETTINGS, quickDayTemplate: { tue: 30 } }, llm }));

      const req = llm.calls[0]?.args[0] as SelectDishesInput;
      expect(req.existingDishes).toEqual([
        { id: String(favorite.id), name: "Tacos", kind: "favorite", mainCategory: "tacos", prepTimeMinutes: 20, weekendOnly: true },
        { id: String(suggested.id), name: "Ärtsoppa", kind: "suggested", mainCategory: "soup", prepTimeMinutes: 20, weekendOnly: false },
      ]);
      expect(req.days.map((d) => d.quickDayLimitMinutes)).toEqual([null, 30, null, null, null, null, null]);
    });

    it("reuses the existing Dish whose id the agent returns for a day with no candidates, and creates no new one", async () => {
      const soup = dish({ name: "Ärtsoppa", mainCategory: "soup", prepTimeMinutes: 45, inRotation: false, suggested: true });
      const llm = new ScriptedLlmAgent({
        selectDishes: { ok: true, value: [{ date: "2026-10-12", dishId: String(soup.id), rationale: "Ärtsoppa again, it is Monday" }] },
      });

      const result = await planWeek(input({ dishes: [soup], llm }));

      expect(result.dinners[0]).toMatchObject({ dishId: soup.id, suggestion: null, rationale: "Ärtsoppa again, it is Monday" });
      expect(result.degradedReasons.filter((r) => r.date === "2026-10-12")).toEqual([]);
    });

    it("drops an existing Dish id that breaks a hard rule that day, and falls back to the seed list", async () => {
      const slow = dish({ name: "Kalops", mainCategory: "beef", prepTimeMinutes: 90, inRotation: false, suggested: true });
      const settings = { ...DEFAULT_PLANNER_SETTINGS, quickDayTemplate: { mon: 30 } };
      const llm = new ScriptedLlmAgent({
        selectDishes: { ok: true, value: [{ date: "2026-10-12", dishId: String(slow.id), rationale: "x" }] },
      });

      const result = await planWeek(input({ dishes: [slow], settings, llm }));

      expect(result.dinners[0]?.dishId).toBeNull();
      expect(result.dinners[0]?.suggestion).not.toBeNull();
      expect(result.degradedReasons.filter((r) => r.date === "2026-10-12" && !r.logOnly)).toEqual([
        expect.objectContaining({ code: "quick-day", params: { name: "Kalops", limit: 30 } }),
      ]);
    });

    it("matches a suggestion to an existing Dish by exact normalised name only: Pasta does not reuse Pasta med lax", async () => {
      const pastaWithSalmon = dish({ name: "Pasta med lax", mainCategory: "pasta", inRotation: false, suggested: true });
      const llm = new ScriptedLlmAgent({
        selectDishes: { ok: true, value: [{ date: "2026-10-12", suggestion: { name: "Pasta", mainCategory: "pasta", prepTimeMinutes: 20 }, rationale: "x" }] },
      });

      const result = await planWeek(input({ dishes: [pastaWithSalmon], llm }));

      expect(result.dinners[0]).toMatchObject({ dishId: null, suggestion: { name: "Pasta" } });
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
      expect(details(result)[0]).toMatch(/^2026-10-12: suggestion "fiskpinnar" dropped: .*Favorite Dish "Fiskpinnar"/);
      expect(details(result)).toContain("2026-10-12: seed fallback used");
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
      expect(details(result)).toEqual([
        NO_AGENT_REASON,
        ...result.dinners.map((d) => `${d.date}: seed fallback used`),
      ]);
    });
    describe("seed fallback across the week", () => {
      /** The agent returns an existing Dish's id on the given dates and nothing elsewhere. */
      const reusing = (byDate: Record<string, Dish>) =>
        new ScriptedLlmAgent({
          selectDishes: {
            ok: true,
            value: Object.entries(byDate).map(([date, d]) => ({ date, dishId: String(d.id), rationale: `reuse ${d.name}` })),
          },
        });

      it("skips seed dishes whose Dish or Main Category is already planned on another date that week", async () => {
        const gratin = dish({ name: "Fiskgratäng", mainCategory: "fish", inRotation: false, suggested: true });
        const pancakes = dish({ name: "Pannkakor", mainCategory: "other", inRotation: false, suggested: true });

        const result = await planWeek(
          input({ dishes: [gratin, pancakes], llm: reusing({ "2026-10-12": gratin, "2026-10-13": pancakes }) }),
        );

        expect(result.dinners.slice(0, 2).map((d) => d.dishId)).toEqual([gratin.id, pancakes.id]);
        // Pannkakor is the Dish already planned; Fiskpinnar med potatis is fish, like Monday.
        expect(result.dinners.slice(2).map((d) => d.suggestion?.name)).toEqual([
          "Köttbullar med potatismos",
          "Pasta med köttfärssås",
          "Korv stroganoff med ris",
          "Kycklinggryta med ris",
          "Tacos",
        ]);
      });

      it("relaxes the Main Category when no other seed is left, but never plans a Dish twice", async () => {
        // Tuesday and Wednesday are 15-minute Quick Days: only Omelett med sallad (vegetarian) fits.
        const lasagne = dish({ name: "Grönsakslasagne", mainCategory: "vegetarian", inRotation: false, suggested: true });
        const settings = { ...DEFAULT_PLANNER_SETTINGS, quickDayTemplate: { tue: 15, wed: 15 } };

        const result = await planWeek(input({ dishes: [lasagne], settings, llm: reusing({ "2026-10-12": lasagne }) }));

        expect(result.dinners[1]?.suggestion?.name).toBe("Omelett med sallad");
        expect(result.dinners[2]).toMatchObject({ dishId: null, suggestion: null, rationale: t("sv", "rationale.noEligible") });
      });
    });

    it("prefers seed dishes not recently planned, so an empty rotation does not repeat last week's seeds", async () => {
      const lastWeek = SEED_DISHES.slice(0, 7).map((s) => dish({ ...s, inRotation: false, suggested: true }));
      const recentlyPlanned = lastWeek.map((d, i) => ({ dishId: String(d.id), name: d.name.toUpperCase(), lastDate: `2026-10-0${i + 1}` }));

      const result = await planWeek(input({ dishes: lastWeek, recentlyPlanned, llm: new NoAgent() }));

      // Not last week's seven, and no Main Category twice: Pytt i panna and Tomatsoppa med bröd are skipped.
      expect(result.dinners.map((d) => d.suggestion?.name)).toEqual([
        "Ärtsoppa",
        "Raggmunk med fläsk",
        "Falukorv med makaroner",
        "Lax i ugn med potatis",
        "Kycklingnuggets med pommes",
        "Vegetarisk lasagne",
        "Hamburgare",
      ]);
    });

    it("still uses a recently planned seed dish when it is the only one eligible", async () => {
      const settings = { ...DEFAULT_PLANNER_SETTINGS, quickDayTemplate: { mon: 15 } };
      const recentlyPlanned = [{ dishId: "1", name: "Omelett med sallad", lastDate: "2026-10-05" }];

      const result = await planWeek(input({ dishes: [], settings, recentlyPlanned, llm: new NoAgent() }));

      expect(result.dinners[0]?.suggestion?.name).toBe("Omelett med sallad");
    });
  });

  describe("degraded path (FR-16)", () => {
    it("still plans round-robin with NoAgent and says no agent is configured", async () => {
      const result = await planWeek(input({ llm: new NoAgent() }));

      expect(result.dinners).toHaveLength(7);
      const [favorites, rest] = [result.dinners.slice(0, 3), result.dinners.slice(3)];
      for (const dinner of favorites) {
        expect(dinner.dishId).not.toBeNull();
        expect(dinner.rationale).toBe(t("sv", "rationale.noAgent"));
      }
      expect(new Set(favorites.map((d) => d.dishId)).size).toBe(3);
      // Once a Week: with the rotation used up, the rest of the week falls back to the seed list.
      for (const dinner of rest) expect(dinner).toMatchObject({ dishId: null, rationale: t("sv", "rationale.seedFallback") });
      expect(result.degradedReasons.filter((r) => !r.logOnly).map((r) => r.code)).toEqual(["no-agent", "seed-fallback", "seed-fallback", "seed-fallback", "seed-fallback"]);
    });

    it("falls back to round-robin when the agent fails", async () => {
      const llm = new ScriptedLlmAgent({ selectDishes: { ok: false, reason: "agent exited with code 1" } });

      const result = await planWeek(input({ llm }));

      expect(result.dinners.every((d) => d.dishId !== null || d.suggestion !== null)).toBe(true);
      expect(details(result)[0]).toBe("agent exited with code 1");
    });
  });
});
