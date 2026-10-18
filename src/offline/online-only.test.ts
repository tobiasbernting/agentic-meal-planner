import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish } from "../dishes/repo.js";
import { createPantryItem } from "../pantry/repo.js";
import { savePlan } from "../planner/repo.js";
import { NoAgent } from "../llm/index.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const NOW = new Date(2026, 9, 21, 18, 30);
const ENV = { TRELLO_KEY: "k", TRELLO_TOKEN: "t0ken", TRELLO_BOARD_ID: "b1" };
const WEEK = "2026-10-19";

async function start(options: Partial<AppOptions> = {}) {
  const app = withEnglish(await buildApp({ ...options, dataDir: mkdtempSync(join(tmpdir(), "mp-online-only-")), now: () => NOW, llm: new NoAgent() }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

/** The opening tags of every form on the page whose action is `action`. */
function formTags(html: string, action: string): string[] {
  return [...html.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes(`action="${action}"`));
}

async function plannedShopping(build: boolean) {
  const app = await start({ env: ENV });
  const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "mjölk", quantity: 2, unit: "dl" }] });
  createPantryItem(app.ctx.db, { name: "mjölk", aliases: [] });
  savePlan(app.ctx.db, { weekStart: WEEK, dinners: [{ date: WEEK, dishId: pasta, isQuickDay: false, lunchThatDay: null, rationale: "r" }], degradedReasons: [] }, NOW.toISOString());
  if (build) await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: WEEK } });
  return { app, pasta };
}

describe("online signal", () => {
  it("starts every page online and loads the signal script from the app", async () => {
    const app = await start();
    for (const url of ["/", "/plan", "/shopping", "/more", "/dishes", "/dishes/new", "/schools", "/pantry", "/settings", "/logs"]) {
      const body = (await app.inject({ method: "GET", url })).body;
      expect(body, url).toMatch(/<html lang="en" data-online="1">/);
      expect(body, url).toContain('<script src="/assets/offline-page.js" defer></script>');
    }
  });

  it("serves the signal script as JavaScript: it starts from the html tag's state, replays when back online and holds htmx while offline", async () => {
    const app = await start();
    const res = await app.inject({ method: "GET", url: "/assets/offline-page.js" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(res.body).toContain("document.documentElement.dataset.online");
    expect(res.body).toContain('type: "replay"');
    expect(res.body).toContain("htmx:beforeRequest");
  });

  it("shows the hint in the UI language on an online-only form", async () => {
    const app = await start();
    const sv = (await app.inject({ method: "GET", url: `/plan?week=${WEEK}`, headers: { cookie: "lang=sv" } })).body;
    const en = (await app.inject({ method: "GET", url: `/plan?week=${WEEK}`, headers: { cookie: "lang=en" } })).body;
    expect(formTags(sv, "/plan/generate")[0]).toContain('data-online-only="Kräver uppkoppling"');
    expect(formTags(en, "/plan/generate")[0]).toContain('data-online-only="Requires connection"');
  });

  it("styles the offline state in the stylesheet", async () => {
    const app = await start();
    const css = (await app.inject({ method: "GET", url: "/assets/app.css" })).body;
    expect(css).toContain('[data-online="0"]');
  });
});

describe("online-only form marker", () => {
  it("marks Plan's generate form with the hint", async () => {
    const app = await start();
    const html = (await app.inject({ method: "GET", url: `/plan?week=${WEEK}` })).body;
    const tags = formTags(html, "/plan/generate");
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toContain('data-online-only="Requires connection"');
  });

  it("marks Shopping's push and Har alltid hemma forms, but not the check form", async () => {
    const { app } = await plannedShopping(true);
    const html = (await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` })).body;
    for (const action of ["/shopping/push", "/shopping/pantry"]) {
      const tags = formTags(html, action);
      expect(tags.length, action).toBeGreaterThan(0);
      for (const tag of tags) expect(tag, action).toContain('data-online-only="Requires connection"');
    }
    const checks = formTags(html, "/shopping/check");
    expect(checks.length).toBeGreaterThan(0);
    for (const tag of checks) expect(tag).not.toContain("data-online-only");
  });

  it("marks Shopping's build form on an unbuilt week", async () => {
    const { app } = await plannedShopping(false);
    const html = (await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` })).body;
    const tags = formTags(html, "/shopping/build");
    expect(tags.length).toBeGreaterThan(0);
    expect(tags[0]).toContain("data-online-only=");
  });

  it("leaves the Dish edit form alone", async () => {
    const { app, pasta } = await plannedShopping(true);
    const html = (await app.inject({ method: "GET", url: `/dishes/${pasta}/edit` })).body;
    const tags = formTags(html, `/dishes/${pasta}`);
    expect(tags.length).toBeGreaterThan(0);
    expect(tags[0]).not.toContain("data-online-only");
  });
});
