import { describe, expect, it } from "vitest";
import { NoAgent } from "./no-agent.js";

describe("NoAgent", () => {
  const agent = new NoAgent();

  it("reports extraction features as unavailable", async () => {
    expect(await agent.extractLunchMenu("page", "2026-10-19")).toEqual({ ok: false, reason: "no agent configured" });
    expect(await agent.extractIngredients("page")).toEqual({ ok: false, reason: "no agent configured" });
    expect(await agent.findRecipe("Tacos")).toEqual({ ok: false, reason: "no agent configured" });
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
      recentlyPlanned: [],
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

  it("skips days with no candidates", async () => {
    const result = await agent.selectDishes({
      days: [
        { date: "2026-10-19", isQuickDay: false, lunch: [] },
        { date: "2026-10-20", isQuickDay: false, lunch: [] },
      ],
      candidates: [[], [{ id: "soup", name: "Soup" }]],
      recentlyPlanned: [],
    });

    expect(result).toEqual({ ok: true, value: [{ date: "2026-10-20", dishId: "soup", rationale: "no agent configured" }] });
  });
});
