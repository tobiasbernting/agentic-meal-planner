import { describe, expect, it } from "vitest";
import type { Dish, Weekday } from "../dishes/repo.js";
import type { LunchEntry } from "../types.js";
import { buildCandidateSets, describeExclusion, exclusionRule, filterEligibleDishes, type DayInput, type ExclusionRule } from "./filter.js";
import { weekdayOf } from "../week.js";

function dish(overrides: Partial<Dish> & { name: string }): Dish {
  return {
    id: overrides.name.length,
    recipeUrl: null,
    adaptationNotes: null,
    prepTimeMinutes: null,
    mainCategory: null,
    inRotation: true,
    preferredDays: [],
    weekendOnly: false,
    ingredients: [],
    ...overrides,
  };
}

function lunch(overrides: Partial<LunchEntry> & { rawText: string }): LunchEntry {
  return { date: "2026-10-16", ...overrides };
}

function day(overrides: Partial<DayInput> = {}): DayInput {
  return {
    date: "2026-10-16",
    weekday: "fri",
    quickDayLimitMinutes: null,
    lunch: [],
    ...overrides,
  };
}

const collisionOn = { categoryCollisionEnabled: true };

describe("weekdayOf", () => {
  const cases: [string, Weekday][] = [
    ["2026-10-12", "mon"],
    ["2026-10-16", "fri"],
    ["2026-10-17", "sat"],
    ["2026-10-18", "sun"],
    ["2026-01-01", "thu"],
  ];
  it.each(cases)("%s is %s", (date, expected) => {
    expect(weekdayOf(date)).toBe(expected);
  });
});

describe("exclusionRule", () => {
  it("is null for an eligible Dish", () => {
    expect(exclusionRule(dish({ name: "Burgers", prepTimeMinutes: 20 }), day({ quickDayLimitMinutes: 30 }), collisionOn)).toBeNull();
  });

  it("names the first hard rule broken, with the parameters the household message needs", () => {
    const fishLunch = lunch({ rawText: "Fiskgratäng", mainCategory: "fish" });
    const cases: [Dish, DayInput, ExclusionRule][] = [
      [dish({ name: "Lasagne", inRotation: false }), day(), { code: "not-in-rotation" }],
      [dish({ name: "fiskgratäng" }), day({ lunch: [fishLunch] }), { code: "same-as-lunch", lunch: "Fiskgratäng" }],
      [dish({ name: "Lax", mainCategory: "fish" }), day({ lunch: [fishLunch] }), { code: "lunch-category", category: "fish", lunch: "Fiskgratäng" }],
      [dish({ name: "Stek", weekendOnly: true }), day(), { code: "weekend-only", date: "2026-10-16", weekday: "fri" }],
      [dish({ name: "Gryta", prepTimeMinutes: 90 }), day({ quickDayLimitMinutes: 30 }), { code: "quick-day", limit: 30, minutes: 90 }],
      [dish({ name: "Soppa" }), day({ quickDayLimitMinutes: 30 }), { code: "quick-day", limit: 30, minutes: null }],
    ];
    for (const [d, input, expected] of cases) expect(exclusionRule(d, input, collisionOn)).toEqual(expected);
  });

  it("puts rotation before lunch, and same-name before category", () => {
    const fishLunch = lunch({ rawText: "Fiskgratäng", mainCategory: "fish" });
    expect(exclusionRule(dish({ name: "Fiskgratäng", mainCategory: "fish", inRotation: false }), day({ lunch: [fishLunch] }), collisionOn)?.code).toBe("not-in-rotation");
    expect(exclusionRule(dish({ name: "Fiskgratäng", mainCategory: "fish" }), day({ lunch: [fishLunch] }), collisionOn)?.code).toBe("same-as-lunch");
  });

  it("excludes a Dish already planned on another date of the Weekly Plan (Once a Week)", () => {
    const burgers = dish({ name: "Burgers", id: 7 });
    const elsewhere = day({ plannedElsewhere: [{ date: "2026-10-12", dishId: 7, name: "Burgers" }] });
    expect(exclusionRule(burgers, elsewhere, collisionOn)).toEqual({ code: "once-a-week", date: "2026-10-12" });
    expect(describeExclusion({ code: "once-a-week", date: "2026-10-12" })).toBe("already planned on 2026-10-12 (Once a Week)");
  });

  it("matches a Dish planned elsewhere by name when it has no id yet (a new Suggested Dish)", () => {
    const elsewhere = day({ plannedElsewhere: [{ date: "2026-10-13", dishId: null, name: "Köttbullar" }] });
    expect(exclusionRule(dish({ name: "köttbullar", id: 99 }), elsewhere, collisionOn)?.code).toBe("once-a-week");
    expect(exclusionRule(dish({ name: "Pannkakor", id: 99 }), elsewhere, collisionOn)).toBeNull();
  });

  it("skips the category rule when collision is off", () => {
    const fishLunch = lunch({ rawText: "Fiskgratäng", mainCategory: "fish" });
    expect(exclusionRule(dish({ name: "Lax", mainCategory: "fish" }), day({ lunch: [fishLunch] }), { categoryCollisionEnabled: false })).toBeNull();
  });
});

describe("describeExclusion", () => {
  const cases: [ExclusionRule, string][] = [
    [{ code: "not-in-rotation" }, "not in rotation"],
    [{ code: "same-as-lunch", lunch: "Fiskgratäng" }, 'same dish as lunch "Fiskgratäng"'],
    [{ code: "lunch-category", category: "fish", lunch: "Fiskgratäng" }, 'same Main Category (fish) as lunch "Fiskgratäng"'],
    [{ code: "weekend-only", date: "2026-10-16", weekday: "fri" }, "Weekend Dish, and 2026-10-16 is a fri"],
    [{ code: "quick-day", limit: 30, minutes: 90 }, "Quick Day (limit 30 min) and prep time is 90 min"],
    [{ code: "quick-day", limit: 30, minutes: null }, "Quick Day (limit 30 min) and prep time is unknown"],
  ];
  it.each(cases)("%j reads %s", (rule, text) => {
    expect(describeExclusion(rule)).toBe(text);
  });
});

describe("filterEligibleDishes", () => {
  it("keeps a Favorite Dish with no constraints and excludes one out of rotation", () => {
    const favorite = dish({ name: "Burgers" });
    const parked = dish({ name: "Lasagne", inRotation: false });

    const result = filterEligibleDishes([favorite, parked], day(), collisionOn);

    expect(result.eligible).toEqual([favorite]);
    expect(result.excluded).toEqual([{ dish: parked, reason: expect.stringMatching(/rotation/i) }]);
  });

  describe("FR-6a: name match with that day's lunch", () => {
    const cases: { title: string; dishName: string; lunch: LunchEntry; blocked: boolean }[] = [
      { title: "exact rawText match blocks", dishName: "Pannkakor", lunch: lunch({ rawText: "Pannkakor" }), blocked: true },
      {
        title: "case, surrounding and inner whitespace are ignored",
        dishName: "köttbullar  med potatis",
        lunch: lunch({ rawText: "  Köttbullar med   Potatis " }),
        blocked: true,
      },
      {
        title: "normalizedName matches even when rawText differs",
        dishName: "Fiskgratäng",
        lunch: lunch({ rawText: "Fiskgratäng med dillsås", normalizedName: "fiskgratäng" }),
        blocked: true,
      },
      {
        title: "a substring is not a match (fuzzy matching is the LLM's job)",
        dishName: "Tacos",
        lunch: lunch({ rawText: "Tacos med kyckling" }),
        blocked: false,
      },
      {
        title: "diacritics are not folded",
        dishName: "Fiskgratang",
        lunch: lunch({ rawText: "Fiskgratäng" }),
        blocked: false,
      },
    ];
    it.each(cases)("$title", ({ dishName, lunch, blocked }) => {
      const candidate = dish({ name: dishName });
      const result = filterEligibleDishes([candidate], day({ lunch: [lunch] }), collisionOn);
      if (blocked) {
        expect(result.eligible).toEqual([]);
        expect(result.excluded).toEqual([{ dish: candidate, reason: expect.stringMatching(/lunch/i) }]);
      } else {
        expect(result.eligible).toEqual([candidate]);
      }
    });
  });

  describe("FR-6b: Main Category collision with that day's lunch", () => {
    const cases: {
      title: string;
      dishCategory: Dish["mainCategory"];
      lunchCategory: string | undefined;
      enabled: boolean;
      blocked: boolean;
    }[] = [
      { title: "same category blocks", dishCategory: "pasta", lunchCategory: "pasta", enabled: true, blocked: true },
      { title: "different category is fine", dishCategory: "pasta", lunchCategory: "fish", enabled: true, blocked: false },
      { title: "Other on the dish never collides", dishCategory: "other", lunchCategory: "other", enabled: true, blocked: false },
      { title: "Other on the lunch never collides", dishCategory: "pasta", lunchCategory: "other", enabled: true, blocked: false },
      { title: "an uncategorised dish never collides", dishCategory: null, lunchCategory: "pasta", enabled: true, blocked: false },
      { title: "an uncategorised lunch never collides", dishCategory: "pasta", lunchCategory: undefined, enabled: true, blocked: false },
      { title: "toggle off disables the rule", dishCategory: "pasta", lunchCategory: "pasta", enabled: false, blocked: false },
    ];
    it.each(cases)("$title", ({ dishCategory, lunchCategory, enabled, blocked }) => {
      const candidate = dish({ name: "Spaghetti bolognese", mainCategory: dishCategory });
      const lunchEntry = lunch({ rawText: "Pasta carbonara", mainCategory: lunchCategory });
      const result = filterEligibleDishes([candidate], day({ lunch: [lunchEntry] }), {
        categoryCollisionEnabled: enabled,
      });
      if (blocked) {
        expect(result.eligible).toEqual([]);
        expect(result.excluded).toEqual([{ dish: candidate, reason: expect.stringMatching(/category/i) }]);
      } else {
        expect(result.eligible).toEqual([candidate]);
      }
    });

    it("collides with any lunch entry of the day, not only the first", () => {
      const candidate = dish({ name: "Fish and chips", mainCategory: "fish" });
      const lunches = [lunch({ rawText: "Pasta", mainCategory: "pasta" }), lunch({ rawText: "Fisk", mainCategory: "fish" })];
      const result = filterEligibleDishes([candidate], day({ lunch: lunches }), collisionOn);
      expect(result.eligible).toEqual([]);
    });
  });

  describe("FR-6c: Weekend Dishes only on Saturday and Sunday", () => {
    const cases: { title: string; date: string; weekday: Weekday; blocked: boolean }[] = [
      { title: "Saturday is allowed", date: "2026-10-17", weekday: "sat", blocked: false },
      { title: "Sunday is allowed", date: "2026-10-18", weekday: "sun", blocked: false },
      { title: "Friday is blocked", date: "2026-10-16", weekday: "fri", blocked: true },
      { title: "Monday is blocked", date: "2026-10-12", weekday: "mon", blocked: true },
    ];
    it.each(cases)("$title", ({ date, weekday, blocked }) => {
      const tacos = dish({ name: "Tacos", weekendOnly: true });
      const result = filterEligibleDishes([tacos], day({ date, weekday }), collisionOn);
      if (blocked) {
        expect(result.eligible).toEqual([]);
        expect(result.excluded).toEqual([{ dish: tacos, reason: expect.stringMatching(/weekend/i) }]);
      } else {
        expect(result.eligible).toEqual([tacos]);
      }
    });

    it("a dish that is not weekend-only is fine on a weekday", () => {
      const burgers = dish({ name: "Burgers", weekendOnly: false });
      expect(filterEligibleDishes([burgers], day({ weekday: "wed" }), collisionOn).eligible).toEqual([burgers]);
    });
  });

  describe("FR-6d: Quick Day prep-time limit", () => {
    const cases: { title: string; prep: number | null; limit: number | null; blocked: boolean }[] = [
      { title: "exactly at the limit is allowed", prep: 30, limit: 30, blocked: false },
      { title: "one minute over is blocked", prep: 31, limit: 30, blocked: true },
      { title: "well under is allowed", prep: 10, limit: 30, blocked: false },
      { title: "unknown prep time is blocked on a Quick Day", prep: null, limit: 30, blocked: true },
      { title: "not a Quick Day: slow dish is fine", prep: 90, limit: null, blocked: false },
      { title: "not a Quick Day: unknown prep time is fine", prep: null, limit: null, blocked: false },
    ];
    it.each(cases)("$title", ({ prep, limit, blocked }) => {
      const candidate = dish({ name: "Oven pancake", prepTimeMinutes: prep });
      const result = filterEligibleDishes([candidate], day({ quickDayLimitMinutes: limit }), collisionOn);
      if (blocked) {
        expect(result.eligible).toEqual([]);
        expect(result.excluded).toEqual([{ dish: candidate, reason: expect.stringMatching(/quick day/i) }]);
      } else {
        expect(result.eligible).toEqual([candidate]);
      }
    });

    it("applies to Weekend Dishes too: a slow Weekend Dish is blocked on a Saturday Quick Day", () => {
      const tacos = dish({ name: "Tacos", weekendOnly: true, prepTimeMinutes: 45 });
      const saturday = day({ date: "2026-10-17", weekday: "sat", quickDayLimitMinutes: 30 });
      expect(filterEligibleDishes([tacos], saturday, collisionOn).eligible).toEqual([]);
    });
  });

  it("keeps input order and gives one exclusion per dish", () => {
    const dishes = [
      dish({ name: "Pasta", mainCategory: "pasta" }),
      dish({ name: "Fisk", mainCategory: "fish", inRotation: false }),
      dish({ name: "Tacos", weekendOnly: true, prepTimeMinutes: 60 }),
      dish({ name: "Soup", mainCategory: "soup", prepTimeMinutes: 20 }),
    ];
    const friday = day({ quickDayLimitMinutes: 30, lunch: [lunch({ rawText: "Pasta", mainCategory: "pasta" })] });
    const result = filterEligibleDishes(dishes, friday, collisionOn);
    expect(result.eligible.map((d) => d.name)).toEqual(["Soup"]);
    expect(result.excluded.map((e) => e.dish.name)).toEqual(["Pasta", "Fisk", "Tacos"]);
  });
});

describe("buildCandidateSets", () => {
  it("returns one candidate set per day, in order, each filtered by its own day", () => {
    const tacos = dish({ name: "Tacos", weekendOnly: true });
    const pasta = dish({ name: "Pasta", mainCategory: "pasta" });
    const days: DayInput[] = [
      day({ date: "2026-10-16", weekday: "fri", lunch: [lunch({ rawText: "Lasagne", mainCategory: "pasta" })] }),
      day({ date: "2026-10-17", weekday: "sat" }),
    ];

    const sets = buildCandidateSets([tacos, pasta], days, collisionOn);

    expect(sets.map((s) => [s.date, s.weekday, s.eligible.map((d) => d.name)])).toEqual([
      ["2026-10-16", "fri", []],
      ["2026-10-17", "sat", ["Tacos", "Pasta"]],
    ]);
    expect(sets[0]!.excluded.map((e) => e.dish.name)).toEqual(["Tacos", "Pasta"]);
  });

  it("returns an empty week for no days", () => {
    expect(buildCandidateSets([dish({ name: "Pasta" })], [], collisionOn)).toEqual([]);
  });
});
