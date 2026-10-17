import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish } from "../dishes/repo.js";
import { NoAgent, ScriptedLlmAgent, type FoundRecipe, type LlmResult } from "../llm/index.js";
import { createPantryItem } from "../pantry/repo.js";
import { savePlan } from "../planner/repo.js";
import { planRunSettled, postPlanRun } from "../plan-run/test-helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// A Wednesday evening, local time; its week starts Monday 2026-10-19.
const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";

async function start(options: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-shopping-"));
  const app = withEnglish(await buildApp({ dataDir, now: () => NOW, llm: new NoAgent(), ...options }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function planWith(app: Awaited<ReturnType<typeof buildApp>>, dishIds: number[]) {
  return savePlan(
    app.ctx.db,
    {
      weekStart: WEEK,
      dinners: dishIds.map((dishId, i) => ({
        date: `2026-10-${19 + i}`,
        dishId,
        isQuickDay: false,
        lunchThatDay: null,
        rationale: "r",
      })),
      degradedReasons: [],
    },
    NOW.toISOString(),
  );
}

describe("GET /shopping", () => {
  it("says there is no plan for the week and links to the Plan view", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/shopping" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No plan for this week");
    expect(res.body).toContain(`href="/plan?week=${WEEK}"`);
    expect(res.body).not.toContain('action="/shopping/build"');
  });

  it("shows the stored list in Buy and Check pantry sections with a rebuild form", async () => {
    const app = await start();
    const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "mjölk", quantity: 2, unit: "dl" }, { name: "pasta", quantity: 400, unit: "g" }] });
    createPantryItem(app.ctx.db, { name: "mjölk", aliases: [] });
    planWith(app, [pasta]);
    const build = await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });

    expect(build.statusCode).toBe(303);
    expect(build.headers.location).toBe(`/shopping?week=${WEEK}`);
    const res = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<section id="buy">[\s\S]*<li>400 g pasta<\/li>/);
    expect(res.body).toMatch(/<section id="check-pantry">[\s\S]*<li>2 dl mjölk<\/li>/);
    expect(res.body.match(/mjölk/g)).toHaveLength(1);
    expect(res.body).toMatch(/<form method="post" action="\/shopping\/build">[\s\S]*name="weekStart" value="2026-10-19"/);
    expect(res.body).toContain('<a href="/shopping" aria-current="page">Shopping</a>');
  });

  it("is built automatically when a plan is generated", async () => {
    const app = await start();
    createDish(app.ctx.db, { name: "Toast", prepTimeMinutes: 10, ingredients: [{ name: "bröd", quantity: null, unit: null }] });

    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });

    const res = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });
    expect(res.body).toMatch(/<section id="buy">[\s\S]*<li>bröd<\/li>/);
  });

  it("offers to build the list when the plan has none yet", async () => {
    const app = await start();
    planWith(app, [createDish(app.ctx.db, { name: "Toast" })]);

    const res = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

    expect(res.body).toContain("No Shopping List yet");
    expect(res.body).toContain('action="/shopping/build"');
  });
});

describe("Plan Run banner on the Shopping List page", () => {
  /** A Weekly Plan of Köttbullar whose Plan Run is held inside the first recipe lookup. */
  async function heldInIngredients() {
    let release!: (value: LlmResult<FoundRecipe>) => void;
    const held = new Promise<LlmResult<FoundRecipe>>((r) => (release = r));
    const llm = new ScriptedLlmAgent({
      selectDishes: (input) => ({ ok: true, value: input.days.map((d) => ({ date: d.date, dishId: String(kottbullar), rationale: "r" })) }),
      findRecipe: () => held,
    });
    const app = await start({ llm });
    const kottbullar = createDish(app.ctx.db, { name: "Köttbullar", prepTimeMinutes: 20 });
    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    for (let i = 0; i < 200; i++) {
      const banner = await app.inject({ method: "GET", url: `/plan-run/banner?week=${WEEK}` });
      if (banner.body.includes("Ingredients")) break;
      await new Promise((r) => setTimeout(r, 2));
    }
    return { app, release };
  }

  it("shows the run's progress with polling and no Rebuild while a run is in flight", async () => {
    const { app, release } = await heldInIngredients();

    const res = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

    expect(res.body).toContain("Ingredients 0 of 7: Köttbullar");
    expect(res.body).toContain(`hx-get="/plan-run/banner?week=${WEEK}&amp;shown=ingredient-resolution"`);
    expect(res.body).toContain('hx-trigger="every 2s"');
    expect(res.body).not.toContain('action="/shopping/build"');
    const sv = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}`, headers: { cookie: "lang=sv" } });
    expect(sv.body).toContain("Ingredienser 0 av 7: Köttbullar");
    release({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
  });

  it("shows the finished outcome without polling and offers Rebuild again", async () => {
    const { app, release } = await heldInIngredients();
    release({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);

    const res = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

    expect(res.body).toContain("Plan Run finished 18:30");
    expect(res.body).not.toMatch(/hx-(get|trigger|swap)/);
    expect(res.body).toContain('action="/shopping/build"');
  });

  it("shows a failed run with its reason", async () => {
    const llm = new ScriptedLlmAgent({
      selectDishes: () => {
        throw new Error("agent exploded");
      },
    });
    const app = await start({ llm });
    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });

    const res = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });

    expect(res.body).toContain("Plan Run failed 18:30: agent exploded");
  });
});
