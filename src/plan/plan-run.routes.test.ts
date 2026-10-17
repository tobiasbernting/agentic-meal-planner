import { mkdtempSync } from "node:fs";
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
    expect(view.body.match(/<strong>Köttbullar<\/strong>/g)).toHaveLength(7);
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
    expect(during.body.match(/<strong>Burgers<\/strong>/g)).toHaveLength(7);
    held.resolve({ ok: true, value: weekDates(WEEK).map((date) => ({ date, dishId: String(stew), rationale: "r" })) });
    await planRunSettled(app, WEEK);
    const after = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });
    expect(after.body.match(/<strong>Stew<\/strong>/g)).toHaveLength(7);
    expect(after.body).not.toContain("<strong>Burgers</strong>");
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
    expect(inFlight.body).toContain("Fas: Hämtar ingredienser");
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
