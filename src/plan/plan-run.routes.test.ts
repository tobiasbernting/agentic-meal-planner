import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish } from "../dishes/repo.js";
import { ScriptedLlmAgent, type FoundRecipe, type LlmResult, type SelectedDish } from "../llm/index.js";
import { savePlan } from "../planner/repo.js";
import { weekDates } from "../week.js";
import { planRunSettled } from "../plan-run/test-helpers.js";
import { createCapturingLogger } from "../logging/logger.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// A Wednesday evening, local time; its week starts Monday 2026-10-19.
const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";

async function start(options: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-plan-run-"));
  const app = withEnglish(await buildApp({ dataDir, now: () => NOW, ...options }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

/** A promise the test resolves when it wants the held agent call to answer. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("Plan Run started from the Plan page", () => {
  it("redirects to the Plan page before the agent has answered and shows the run in progress", async () => {
    const held = deferred<LlmResult<SelectedDish[]>>();
    const llm = new ScriptedLlmAgent({ selectDishes: () => held.promise });
    const app = await start({ llm });
    createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });

    const res = await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/plan?week=${WEEK}`);
    const view = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(view.body).toContain("Plan Run in progress since 18:30");
    expect(view.body).toContain("Dish selection");
    held.resolve({ ok: false, reason: "released" });
  });

  it("polls while in flight and stops polling once the run has finished", async () => {
    const held = deferred<LlmResult<SelectedDish[]>>();
    const app = await start({ llm: new ScriptedLlmAgent({ selectDishes: () => held.promise }) });
    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });

    const inFlight = await banner(app, WEEK);
    expect(inFlight.body).toContain(`hx-get="/plan-run/banner?week=${WEEK}&amp;shown=dish-selection"`);
    expect(inFlight.body).toContain('hx-trigger="every 2s"');
    expect(inFlight.body).toContain('hx-swap="outerHTML"');

    held.resolve({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);

    const finished = await banner(app, WEEK);
    expect(finished.body).toContain("Plan Run finished 18:30");
    expect(finished.body).toContain('class="plan-run plan-run-done"');
    expect(finished.body).not.toMatch(/hx-(get|trigger|swap)/);
  });

  it("shows done of total and the Dish being resolved during Ingredient resolution, with the dinners already on the page", async () => {
    const held = deferred<LlmResult<FoundRecipe>>();
    const llm = new ScriptedLlmAgent({
      selectDishes: (input) => ({ ok: true, value: input.days.map((d) => ({ date: d.date, dishId: String(kottbullar), rationale: "r" })) }),
      findRecipe: () => held.promise,
    });
    const app = await start({ llm });
    const kottbullar = createDish(app.ctx.db, { name: "Köttbullar", prepTimeMinutes: 20 });

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    await until(async () => (await banner(app, WEEK)).body.includes("Ingredients"));

    const view = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(view.body).toContain("Ingredient resolution");
    expect(view.body).toContain("Ingredients 0 of 7: Köttbullar");
    expect(view.body.match(/<div class="day-dinner">/g)).toHaveLength(7);
    expect(view.body.match(/<div class="day-dinner">Köttbullar<\/div>/g)).toHaveLength(1); // Once a Week
    held.resolve({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
  });

  it("places the almanac-style banner between the status block and the days, with Byt and Regenerate hidden hooks", async () => {
    const held = deferred<LlmResult<FoundRecipe>>();
    const llm = new ScriptedLlmAgent({
      selectDishes: (input) => ({ ok: true, value: input.days.map((d) => ({ date: d.date, dishId: String(kottbullar), rationale: "r" })) }),
      findRecipe: () => held.promise,
    });
    const app = await start({ llm });
    const kottbullar = createDish(app.ctx.db, { name: "Köttbullar", prepTimeMinutes: 20 });
    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    await until(async () => (await banner(app, WEEK)).body.includes("Ingredients"));

    const body = (await app.inject({ method: "GET", url: `/plan?week=${WEEK}` })).body;

    const at = body.indexOf('id="plan-run-banner"');
    expect(at).toBeGreaterThan(body.indexOf("plan-status"));
    expect(at).toBeLessThan(body.indexOf('id="day-'));
    expect(body).toMatch(/<div id="plan-run-banner" class="plan-run plan-run-active notice" role="status"/);
    expect(body).toContain('<strong class="notice-label">Phase</strong> Ingredient resolution');
    expect(body).not.toContain('action="/plan/generate"');
    expect(body).not.toContain('action="/plan/regenerate"');
    // Byt hides through the stylesheet: every action but the Recept link, after an active banner.
    expect(readFileSync("public/app.css", "utf8")).toContain(".plan-run-active ~ .day .actions > :not(a) { display: none; }");
    held.resolve({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
  });

  it("keeps the previous plan on the page during a Regenerate until the new one is saved", async () => {
    const held = deferred<LlmResult<SelectedDish[]>>();
    const app = await start({ llm: new ScriptedLlmAgent({ selectDishes: () => held.promise }) });
    const burgers = createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });
    const stew = createDish(app.ctx.db, { name: "Stew", prepTimeMinutes: 20 });
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: dinnersOf(burgers), degradedReasons: [] }, NOW.toISOString());

    await app.inject({ method: "POST", url: "/plan/regenerate", payload: { weekStart: WEEK } });

    const during = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(during.body.match(/<div class="day-dinner">Burgers<\/div>/g)).toHaveLength(7);
    held.resolve({ ok: true, value: weekDates(WEEK).map((date) => ({ date, dishId: String(stew), rationale: "r" })) });
    await planRunSettled(app, WEEK);
    const after = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(after.body.match(/<div class="day-dinner">Stew<\/div>/g)).toHaveLength(1); // Once a Week
    expect(after.body).not.toContain('<div class="day-dinner">Burgers</div>');
  });

  it("hides Generate and Regenerate while the run is in flight and offers them again when it has finished", async () => {
    const held = deferred<LlmResult<SelectedDish[]>>();
    const app = await start({ llm: new ScriptedLlmAgent({ selectDishes: () => held.promise }) });
    const burgers = createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });
    const next = "2026-10-26";
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: dinnersOf(burgers), degradedReasons: [] }, NOW.toISOString());

    await app.inject({ method: "POST", url: "/plan/regenerate", payload: { weekStart: WEEK } });
    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: next } });

    expect((await app.inject({ method: "GET", url: `/plan?week=${WEEK}` })).body).not.toContain('action="/plan/regenerate"');
    expect((await app.inject({ method: "GET", url: `/plan?week=${next}` })).body).not.toContain('action="/plan/generate"');
    held.resolve({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
    await planRunSettled(app, next);
    expect((await app.inject({ method: "GET", url: `/plan?week=${WEEK}` })).body).toContain('action="/plan/regenerate"');
  });

  it.each(["/plan/generate", "/plan/regenerate"])("refuses %s for a week with a run in flight, with a notice and no new agent call", async (url) => {
    const held = deferred<LlmResult<SelectedDish[]>>();
    const llm = new ScriptedLlmAgent({ selectDishes: () => held.promise });
    const app = await start({ llm });
    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });

    const again = await app.inject({ method: "POST", url, payload: { weekStart: WEEK } });

    expect(again.statusCode).toBe(303);
    expect(again.headers.location).toBe(`/plan?week=${WEEK}&notice=run-in-progress`);
    const view = await app.inject({ method: "GET", url: again.headers.location as string });
    expect(view.body).toContain("A Plan Run is already in progress for this week");
    held.resolve({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
    expect(llm.calls.filter((c) => c.method === "selectDishes")).toHaveLength(1);
  });

  it("withholds Confirm while a Regenerate is in flight and refuses a confirm posted meanwhile (FR-9a)", async () => {
    const held = deferred<LlmResult<SelectedDish[]>>();
    const app = await start({ llm: new ScriptedLlmAgent({ selectDishes: () => held.promise }) });
    const burgers = createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: dinnersOf(burgers), degradedReasons: [] }, NOW.toISOString());
    await app.inject({ method: "POST", url: "/plan/regenerate", payload: { weekStart: WEEK } });

    const during = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(during.body).not.toContain('action="/plan/confirm"');
    const confirm = await app.inject({ method: "POST", url: "/plan/confirm", payload: { weekStart: WEEK } });

    expect(confirm.statusCode).toBe(303);
    expect(confirm.headers.location).toBe(`/plan?week=${WEEK}&notice=run-in-progress`);
    expect((await app.inject({ method: "GET", url: `/plan?week=${WEEK}` })).body).toContain("Status: generated");
    held.resolve({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
    expect((await app.inject({ method: "GET", url: `/plan?week=${WEEK}` })).body).toContain('action="/plan/confirm"');
  });

  it("runs two different weeks at the same time", async () => {
    const holds = [deferred<LlmResult<SelectedDish[]>>(), deferred<LlmResult<SelectedDish[]>>()];
    let call = 0;
    const llm = new ScriptedLlmAgent({ selectDishes: () => holds[call++]!.promise });
    const app = await start({ llm });
    const next = "2026-10-26";

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: next } });

    expect((await banner(app, WEEK)).body).toContain("Plan Run in progress");
    expect((await banner(app, next)).body).toContain("Plan Run in progress");
    expect(llm.calls.filter((c) => c.method === "selectDishes")).toHaveLength(2);
    holds[1]!.resolve({ ok: false, reason: "released" });
    await planRunSettled(app, next);
    expect((await banner(app, WEEK)).body).toContain("Plan Run in progress");
    holds[0]!.resolve({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
  });

  it("keeps the finished outcome until the next run of that week replaces it", async () => {
    let held = deferred<LlmResult<SelectedDish[]>>();
    const app = await start({ llm: new ScriptedLlmAgent({ selectDishes: () => held.promise }) });
    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    held.resolve({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);

    expect((await app.inject({ method: "GET", url: `/plan?week=${WEEK}` })).body).toContain("Plan Run finished 18:30");
    expect((await app.inject({ method: "GET", url: `/plan?week=${WEEK}` })).body).toContain("Plan Run finished 18:30");

    held = deferred();
    await app.inject({ method: "POST", url: "/plan/regenerate", payload: { weekStart: WEEK } });
    const view = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(view.body).toContain("Plan Run in progress");
    expect(view.body).not.toContain("Plan Run finished");
    held.resolve({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
  });

  it("shows the banner in Swedish", async () => {
    const held = deferred<LlmResult<FoundRecipe>>();
    const llm = new ScriptedLlmAgent({
      selectDishes: (input) => ({ ok: true, value: input.days.map((d) => ({ date: d.date, dishId: String(kottbullar), rationale: "r" })) }),
      findRecipe: () => held.promise,
    });
    const app = await start({ llm });
    const kottbullar = createDish(app.ctx.db, { name: "Köttbullar", prepTimeMinutes: 20 });
    const sv = { cookie: "lang=sv" };

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    await until(async () => (await banner(app, WEEK)).body.includes("Ingredients"));

    const inFlight = await app.inject({ method: "GET", url: `/plan-run/banner?week=${WEEK}`, headers: sv });
    expect(inFlight.body).toContain("Planering pågår sedan 18:30");
    expect(inFlight.body).toContain('<strong class="notice-label">Fas</strong> Hämtar ingredienser');
    expect(inFlight.body).toContain("Ingredienser 0 av 7: Köttbullar");
    const refused = await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    expect((await app.inject({ method: "GET", url: refused.headers.location as string, headers: sv })).body).toContain("En planering pågår redan");
    held.resolve({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
    expect((await app.inject({ method: "GET", url: `/plan-run/banner?week=${WEEK}`, headers: sv })).body).toContain("Planeringen klar 18:30");
  });
});

describe("a Plan Run that throws", () => {
  it("logs the error under the request's run id and lets the week run again", async () => {
    const { logger, records } = createCapturingLogger();
    const llm = new ScriptedLlmAgent({
      selectDishes: () => {
        throw new Error("agent exploded");
      },
    });
    const app = await start({ logger, llm });

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    await planRunSettled(app, WEEK);

    const runId = records.find((r) => r.msg === "request completed" && r.url === "/plan/generate")?.runId;
    expect(records).toContainEqual(
      expect.objectContaining({ level: "error", component: "plan-run", runId, weekStart: WEEK, err: "agent exploded" }),
    );
    expect((await app.inject({ method: "GET", url: `/plan?week=${WEEK}` })).body).toContain('action="/plan/generate"');
  });

  it("shows the failure with its reason in the banner, without polling, in English and Swedish", async () => {
    const llm = new ScriptedLlmAgent({
      selectDishes: () => {
        throw new Error("agent exploded");
      },
    });
    const app = await start({ llm });

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    await planRunSettled(app, WEEK);

    const view = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(view.body).toContain("Plan Run failed 18:30: agent exploded");
    expect(view.body).toMatch(/<div id="plan-run-banner" class="plan-run plan-run-failed notice" role="alert">/);
    expect((await banner(app, WEEK)).body).not.toMatch(/hx-(get|trigger|swap)/);
    const sv = await app.inject({ method: "GET", url: `/plan-run/banner?week=${WEEK}`, headers: { cookie: "lang=sv" } });
    expect(sv.body).toContain("Planeringen misslyckades 18:30: agent exploded");
  });
  it("leaves the week's stored plan and Shopping List as they were", async () => {
    const llm = new ScriptedLlmAgent({
      selectDishes: () => {
        throw new Error("agent exploded");
      },
    });
    const app = await start({ llm });
    const pasta = createDish(app.ctx.db, { name: "Pasta", prepTimeMinutes: 20, ingredients: [{ name: "pasta", quantity: 400, unit: "g" }] });
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: dinnersOf(pasta), degradedReasons: [] }, NOW.toISOString());
    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });
    const dinners = async () => (await app.inject({ method: "GET", url: `/plan?week=${WEEK}` })).body.match(/<div class="day-dinner">[^<]*<\/div>/g);
    const shoppingList = async () => (await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` })).body.match(/<section id="(buy|check-pantry)">[\s\S]*?<\/section>/g);
    const before = { dinners: await dinners(), shoppingList: await shoppingList() };

    await app.inject({ method: "POST", url: "/plan/regenerate", payload: { weekStart: WEEK } });
    await planRunSettled(app, WEEK);

    expect(before.dinners).toHaveLength(7);
    expect(before.shoppingList?.join("")).toContain("400 g pasta");
    expect({ dinners: await dinners(), shoppingList: await shoppingList() }).toEqual(before);
  });

  it("keeps the new plan when a Regenerate throws after Dish selection (the plan is saved before ingredients)", async () => {
    let stew = 0;
    const llm = new ScriptedLlmAgent({
      selectDishes: (input) => ({ ok: true, value: input.days.map((d) => ({ date: d.date, dishId: String(stew), rationale: "r" })) }),
      findRecipe: () => {
        throw new Error("recipe search exploded");
      },
    });
    const app = await start({ llm });
    const burgers = createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });
    stew = createDish(app.ctx.db, { name: "Stew", prepTimeMinutes: 20 });
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: dinnersOf(burgers), degradedReasons: [] }, NOW.toISOString());

    await app.inject({ method: "POST", url: "/plan/regenerate", payload: { weekStart: WEEK } });
    await planRunSettled(app, WEEK);

    const view = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(view.body.match(/<div class="day-dinner">Stew<\/div>/g)).toHaveLength(1); // Once a Week
    expect(view.body).not.toContain('<div class="day-dinner">Burgers</div>');
    expect(view.body).toContain("Plan Run failed 18:30: recipe search exploded");
    expect(view.body).toContain('action="/plan/regenerate"');
  });

  it("offers Regenerate again after a failure, and the next run replaces the failed outcome", async () => {
    let fail = true;
    const held = deferred<LlmResult<SelectedDish[]>>();
    const llm = new ScriptedLlmAgent({
      selectDishes: () => {
        if (fail) throw new Error("agent exploded");
        return held.promise;
      },
    });
    const app = await start({ llm });
    const burgers = createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });
    savePlan(app.ctx.db, { weekStart: WEEK, dinners: dinnersOf(burgers), degradedReasons: [] }, NOW.toISOString());
    await app.inject({ method: "POST", url: "/plan/regenerate", payload: { weekStart: WEEK } });
    await planRunSettled(app, WEEK);

    const failed = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(failed.body).toContain('action="/plan/regenerate"');

    fail = false;
    await app.inject({ method: "POST", url: "/plan/regenerate", payload: { weekStart: WEEK } });
    const during = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(during.body).toContain("Plan Run in progress");
    expect(during.body).not.toContain("Plan Run failed");
    held.resolve({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
    const after = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(after.body).toContain("Plan Run finished 18:30");
    expect(after.body).not.toContain("Plan Run failed");
  });
});

describe("Plan Run banner polling", () => {
  it("asks HTMX to reload the page once the dinners are saved, and again when the run ends", async () => {
    const held = deferred<LlmResult<FoundRecipe>>();
    const llm = new ScriptedLlmAgent({
      selectDishes: (input) => ({ ok: true, value: input.days.map((d) => ({ date: d.date, dishId: String(burgers), rationale: "r" })) }),
      findRecipe: () => held.promise,
    });
    const app = await start({ llm });
    const burgers = createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });
    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    await until(async () => (await banner(app, WEEK)).body.includes("Ingredients"));

    const poll = (shown: string) => app.inject({ method: "GET", url: `/plan-run/banner?week=${WEEK}&shown=${shown}` });
    expect((await poll("dish-selection")).headers["hx-refresh"]).toBe("true");
    expect((await poll("ingredient-resolution")).headers["hx-refresh"]).toBeUndefined();
    held.resolve({ ok: false, reason: "released" });
    await planRunSettled(app, WEEK);
    expect((await poll("ingredient-resolution")).headers["hx-refresh"]).toBe("true");
  });
});

async function banner(app: Awaited<ReturnType<typeof start>>, weekStart: string) {
  return app.inject({ method: "GET", url: `/plan-run/banner?week=${weekStart}` });
}

/** Waits (briefly) for a condition the detached run reaches on its own. */
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition not reached");
}

function dinnersOf(dishId: number) {
  return weekDates(WEEK).map((date) => ({ date, dishId, isQuickDay: false, lunchThatDay: null, rationale: "r" }));
}
