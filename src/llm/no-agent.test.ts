import { describe, expect, it } from "vitest";
import { NoAgent } from "./no-agent.js";
import type { SeedDish } from "./types.js";

const seedDishes: SeedDish[] = [
  { name: "Seed A", mainCategory: "pasta", prepTimeMinutes: 20 },
  { name: "Seed B", mainCategory: "fish", prepTimeMinutes: 30 },
];
const base = { recentlyPlanned: [], suggestionStyle: "style", seedDishes };

describe("NoAgent", () => {
  const agent = new NoAgent();

  it("reports extraction features as unavailable", async () => {
    expect(await agent.extractLunchMenu("page", "2026-10-19")).toEqual({ ok: false, reason: "no agent configured" });
    expect(await agent.extractIngredients("page")).toEqual({ ok: false, reason: "no agent configured" });
    expect(await agent.findRecipe("Tacos")).toEqual({ ok: false, reason: "no agent configured" });
    expect(await agent.suggestMainCategory("Tacos", ["tacos", "other"])).toEqual({ ok: false, reason: "no agent configured" });
    expect(await agent.matchPantryItems({ ingredients: ["milk"], pantry: [] })).toEqual({
      ok: false,
      reason: "no agent configured",
    });
  });

  it("selects dishes round-robin over each day's candidates with the degraded rationale", async () => {
    const tacos = { id: "tacos", name: "Tacos" };
    const burgers = { id: "burgers", name: "Burgers" };
    const soup = { id: "soup", name: "Soup" };

    const result = await agent.selectDishes({
      days: [
        { date: "2026-10-19", isQuickDay: false, lunch: [] },
        { date: "2026-10-20", isQuickDay: false, lunch: [] },
        { date: "2026-10-21", isQuickDay: false, lunch: [] },
        { date: "2026-10-22", isQuickDay: true, lunch: [] },
      ],
      candidates: [
        [tacos, burgers, soup],
        [tacos, burgers, soup],
        [tacos, burgers, soup],
        [burgers],
      ],
      ...base,
    });

    expect(result).toEqual({
      ok: true,
      value: [
        { date: "2026-10-19", dishId: "tacos", rationale: "no agent configured" },
        { date: "2026-10-20", dishId: "burgers", rationale: "no agent configured" },
        { date: "2026-10-21", dishId: "soup", rationale: "no agent configured" },
        { date: "2026-10-22", dishId: "burgers", rationale: "no agent configured" },
      ],
    });
  });

  it("fills days with no candidates from the seed list round-robin, leaving other days on candidates", async () => {
    const result = await agent.selectDishes({
      days: [
        { date: "2026-10-19", isQuickDay: false, lunch: [] },
        { date: "2026-10-20", isQuickDay: false, lunch: [] },
        { date: "2026-10-21", isQuickDay: false, lunch: [] },
        { date: "2026-10-22", isQuickDay: false, lunch: [] },
      ],
      candidates: [[], [{ id: "soup", name: "Soup" }], [], []],
      ...base,
    });

    expect(result).toEqual({
      ok: true,
      value: [
        { date: "2026-10-19", suggestion: seedDishes[0], rationale: "no agent configured" },
        { date: "2026-10-20", dishId: "soup", rationale: "no agent configured" },
        { date: "2026-10-21", suggestion: seedDishes[1], rationale: "no agent configured" },
        { date: "2026-10-22", suggestion: seedDishes[0], rationale: "no agent configured" },
      ],
    });
  });

  it("skips empty days when the seed list is empty", async () => {
    const result = await agent.selectDishes({
      days: [{ date: "2026-10-19", isQuickDay: false, lunch: [] }],
      candidates: [[]],
      ...base,
      seedDishes: [],
    });
    expect(result).toEqual({ ok: true, value: [] });
  });
});
