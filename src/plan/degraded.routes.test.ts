import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { NoAgent, ScriptedLlmAgent, type SelectDishesInput } from "../llm/index.js";
import { createDish } from "../dishes/repo.js";
import { createSchool } from "../schools/repo.js";
import { createCapturingLogger } from "../logging/logger.js";
import { planRunSettled } from "../plan-run/test-helpers.js";
import { savePlan } from "../planner/repo.js";
import { weekDates } from "../week.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";
const TUESDAY = "2026-10-20";

async function start(options: Partial<AppOptions> = {}) {
  const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-degraded-")), now: () => NOW, ...options });
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function row(body: string, date: string): string {
  const m = body.match(new RegExp(`<article[^>]*id="day-${date}"[\\s\\S]*?</article>`));
  if (!m) throw new Error(`no row for ${date}`);
  return m[0];
}

const top = (body: string) => body.slice(0, body.indexOf("<article"));
const cookie = (lang: "sv" | "en") => ({ cookie: `lang=${lang}` });

/** Tuesday's school lunch is fish; the agent suggests salmon pasta (fish) there and a different beef stew on every other day. */
function fishLunchSetup(seen: SelectDishesInput[] = []) {
  return new ScriptedLlmAgent({
    extractLunchMenu: { ok: true, value: [{ date: TUESDAY, rawText: "Fiskgratäng", mainCategory: "fish" }] },
    selectDishes: (input: SelectDishesInput) => {
      seen.push(input);
      return {
        ok: true,
        value: input.days.map((d, i) => ({
          date: d.date,
          suggestion: d.date === TUESDAY ? { name: "Laxpasta", mainCategory: "fish", prepTimeMinutes: 25 } : { name: `Kalops ${i}`, mainCategory: "beef", prepTimeMinutes: 25 },
          rationale: "r",
        })),
      };
    },
  });
}

describe("degraded reasons on the day they affect", () => {
  it.each([
    ["sv", "Lunchen var fisk, så Laxpasta valdes bort."],
    ["en", "Lunch was fish, so Laxpasta was left out."],
  ] as const)("shows a dropped suggestion on its date in household language (%s)", async (lang, text) => {
    const { logger, records } = createCapturingLogger();
    const app = await start({ logger, llm: fishLunchSetup(), fetchPage: async () => "<html>menu</html>" });
    createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK }, headers: cookie(lang) });
    await planRunSettled(app, WEEK);
    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}`, headers: cookie(lang) });

    expect(row(res.body, TUESDAY)).toMatch(new RegExp(`class="notice"[\\s\\S]*${text}`));
    const label = lang === "sv" ? "Ändrad" : "Changed";
    expect(row(res.body, TUESDAY)).toContain(`<strong class="notice-label">${label}</strong>`);
    expect(res.body.split(`<strong class="notice-label">${label}</strong>`)).toHaveLength(2);
    expect(top(res.body)).not.toContain('class="notice"');
    expect(res.body).not.toContain("dropped");
    expect(res.body).not.toContain("seed fallback");
    const warn = records.find((r) => r.level === "warn" && r.component === "planner");
    expect(warn?.degradedReasons).toContainEqual(expect.stringMatching(/^2026-10-20: suggestion "Laxpasta" dropped: same Main Category/));
  });

  it.each([
    ["sv", "Burgers finns redan i veckans plan, så den valdes bort."],
    ["en", "Burgers is already planned this week, so it was left out."],
  ] as const)("shows a Dish the agent picked twice on the second date, in household language (%s)", async (lang, text) => {
    const llm = new ScriptedLlmAgent({
      selectDishes: (input: SelectDishesInput) => ({ ok: true, value: input.days.slice(0, 2).map((d) => ({ date: d.date, dishId: String(burgers), rationale: "r" })) }),
    });
    const app = await start({ llm });
    const burgers = createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK }, headers: cookie(lang) });
    await planRunSettled(app, WEEK);
    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}`, headers: cookie(lang) });

    expect(row(res.body, WEEK)).toContain('<div class="day-dinner">Burgers</div>');
    expect(row(res.body, TUESDAY)).toMatch(new RegExp(`class="notice"[\\s\\S]*${text}`));
    expect(row(res.body, TUESDAY)).not.toContain('<div class="day-dinner">Burgers</div>');
  });

  it.each([
    ["sv", "Agenten svarade inte, så rätterna valdes automatiskt."],
    ["en", "The agent did not answer, so the dishes were picked automatically."],
  ] as const)("says once, in household language, that the agent failed for the week (%s)", async (lang, text) => {
    const { logger, records } = createCapturingLogger();
    const llm = new ScriptedLlmAgent({ selectDishes: { ok: false, reason: "agent exited with code 1" } });
    const app = await start({ logger, llm });
    createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK }, headers: cookie(lang) });
    await planRunSettled(app, WEEK);
    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}`, headers: cookie(lang) });

    expect(top(res.body)).toContain(text);
    expect(res.body.split(text)).toHaveLength(2);
    expect(res.body).not.toContain("exited with code");
    expect(records).toContainEqual(expect.objectContaining({ level: "warn", degradedReasons: expect.arrayContaining(["agent exited with code 1"]) }));
  });

  it.each([
    ["sv", "Vald automatiskt, ingen agent är inställd."],
    ["en", "Picked automatically; no agent is set up."],
  ] as const)("writes the no-agent rationale in household language (%s)", async (lang, text) => {
    const app = await start({ llm: new NoAgent() });
    createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK }, headers: cookie(lang) });
    await planRunSettled(app, WEEK);
    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}`, headers: cookie(lang) });

    expect(row(res.body, WEEK)).toContain(`<p class="why">${text}</p>`);
    expect(res.body).not.toContain("no agent configured");
  });

  it("renders a plan stored before reason codes without raw text", async () => {
    const app = await start();
    const dinners = weekDates(WEEK).map((date) => ({ date, dishId: null, isQuickDay: false, lunchThatDay: null, rationale: "" }));
    savePlan(app.ctx.db, { weekStart: WEEK, dinners, degradedReasons: [] }, NOW.toISOString());
    app.ctx.db.prepare("UPDATE weekly_plan SET degraded_reasons = ?").run(JSON.stringify([`${TUESDAY}: seed fallback used`, "agent exited with code 1"]));

    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}`, headers: cookie("en") });

    expect(row(res.body, TUESDAY)).toContain('class="notice"');
    expect(top(res.body)).toContain('class="notice"');
    expect(res.body).not.toContain("seed fallback");
    expect(res.body).not.toContain("exited with code");
  });
});

describe("rationale language", () => {
  it.each(["sv", "en"] as const)("asks the agent for rationales in the UI language (%s)", async (lang) => {
    const seen: SelectDishesInput[] = [];
    const app = await start({ llm: fishLunchSetup(seen), fetchPage: async () => "<html>menu</html>" });

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK }, headers: cookie(lang) });
    await planRunSettled(app, WEEK);

    expect(seen[0]?.language).toBe(lang);
  });
});
