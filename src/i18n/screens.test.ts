import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDish, getDish } from "../dishes/repo.js";
import { savePlan } from "../planner/repo.js";
import { createPantryItem } from "../pantry/repo.js";
import { createSchool } from "../schools/repo.js";
import { MAIN_CATEGORIES, MAIN_CATEGORY_KEYS } from "../dishes/categories.js";
import { postPlanRun } from "../plan-run/test-helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function makeApp() {
  const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-i18n-")), now: () => new Date(2026, 9, 28, 12) });
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

describe("every screen renders in Swedish by default (FR-18)", () => {
  it("renders each route in Swedish with lang=sv", async () => {
    const app = await makeApp();
    const school = createSchool(app.ctx.db, { name: "Skolan", url: "https://example.test/menu" });
    const dish = createDish(app.ctx.db, {
      name: "Köttbullar",
      recipeUrl: null,
      adaptationNotes: null,
      prepTimeMinutes: 20,
      mainCategory: "beef",
      inRotation: true,
      preferredDays: ["fri"],
      weekendOnly: false,
      ingredients: [],
    });
    const item = createPantryItem(app.ctx.db, { name: "Salt", aliases: [] });
    const dishId = typeof dish === "number" ? dish : dish.id;
    const schoolId = typeof school === "number" ? school : school.id;
    const itemId = typeof item === "number" ? item : item.id;

    const screens: [string, string][] = [
      ["/", "Skollunch"],
      ["/plan", "Veckoplan"],
      ["/shopping", "Inköpslista"],
      ["/dishes", "Rätter"],
      ["/dishes/new", "Ny rätt"],
      [`/dishes/${dishId}/edit`, "Huvudkategori"],
      ["/schools", "Skolor"],
      [`/schools/${schoolId}/edit`, "Redigera skola"],
      ["/pantry", "Skafferi"],
      [`/pantry/${itemId}/edit`, "Redigera skafferivara"],
      ["/settings", "Inställningar"],
      ["/settings/quick-days?week=2026-10-26", "Snabbdagar"],
    ];
    for (const [url, text] of screens) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain('<html lang="sv">');
      expect(res.body, url).toContain(text);
      expect(res.body, url).toContain("Måltidsplaneraren");
    }
  });

  it("localises the nav and weekday names", async () => {
    const app = await makeApp();
    await postPlanRun(app, "/plan/generate", { weekStart: "2026-10-26" });
    const res = await app.inject({ method: "GET", url: "/plan?week=2026-10-26" });
    expect(res.body).toContain('<a href="/">Idag</a>');
    expect(res.body).toContain("Måndag");
  });
  it("localises the sinks section of the Shopping List (#32, #37)", async () => {
    const app = await makeApp();
    const pasta = createDish(app.ctx.db, {
      name: "Pasta",
      recipeUrl: null,
      adaptationNotes: null,
      prepTimeMinutes: 20,
      mainCategory: "vegetarian",
      inRotation: true,
      preferredDays: [],
      weekendOnly: false,
      ingredients: [{ name: "pasta", quantity: 400, unit: "g" }],
    });
    const pastaId = typeof pasta === "number" ? pasta : pasta.id;
    savePlan(
      app.ctx.db,
      { weekStart: "2026-10-26", dinners: [{ date: "2026-10-26", dishId: pastaId, isQuickDay: false, lunchThatDay: null, rationale: "r" }], degradedReasons: [] },
      new Date(2026, 9, 28, 12).toISOString(),
    );
    await app.inject({ method: "POST", url: "/shopping/build", payload: { weekStart: "2026-10-26" } });
    const sv = (await app.inject({ method: "GET", url: "/shopping?week=2026-10-26" })).body;
    expect(sv).toContain('<section id="sinks"><h2>Mottagare</h2>');
    expect(sv).toContain("Skicka igen");
    expect(sv).not.toContain("Push again");
    const en = (await app.inject({ method: "GET", url: "/shopping?week=2026-10-26", headers: { cookie: "lang=en" } })).body;
    expect(en).toContain("Push again");
    const settings = (await app.inject({ method: "GET", url: "/settings" })).body;
    expect(settings).toContain("WEBHOOK_SECRET");
    expect(settings).not.toContain("Shopping List Sinks");
  });
});

describe("Main Category labels", () => {
  it("shows Swedish labels in the dish form and list", async () => {
    const app = await makeApp();
    const form = await app.inject({ method: "GET", url: "/dishes/new" });
    for (const key of MAIN_CATEGORY_KEYS) {
      expect(form.body).toContain(`<option value="${key}">${MAIN_CATEGORIES[key].sv}</option>`);
    }
    expect(form.body).not.toContain("Chicken");
    createDish(app.ctx.db, {
      name: "Kyckling i ugn",
      recipeUrl: null,
      adaptationNotes: null,
      prepTimeMinutes: null,
      mainCategory: "chicken",
      inRotation: true,
      preferredDays: [],
      weekendOnly: false,
      ingredients: [],
    });
    expect((await app.inject({ method: "GET", url: "/dishes" })).body).toContain("Kyckling");
  });

  it("shows English labels with the lang=en cookie", async () => {
    const app = await makeApp();
    const form = await app.inject({ method: "GET", url: "/dishes/new", headers: { cookie: "lang=en" } });
    expect(form.body).toContain('<option value="chicken">Chicken</option>');
  });

  it("stores the category key, not the label, after a save", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/dishes",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "name=Laxpasta&main_category=fish&in_rotation=1",
    });
    expect(res.statusCode).toBe(303);
    const row = app.ctx.db.prepare("SELECT id, main_category FROM dish WHERE name = ?").get("Laxpasta") as {
      id: number;
      main_category: string;
    };
    expect(row.main_category).toBe("fish");
    expect(getDish(app.ctx.db, row.id)?.mainCategory).toBe("fish");
  });
});
