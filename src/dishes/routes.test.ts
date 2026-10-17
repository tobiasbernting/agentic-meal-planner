import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { ScriptedLlmAgent } from "../llm/index.js";
import { MAIN_CATEGORY_KEYS } from "./categories.js";
import { createDish, getDish, listDishes } from "./repo.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function start(llm?: ScriptedLlmAgent) {
  const app = withEnglish(await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-dishes-http-")), ...(llm ? { llm } : {}) }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

/** Form fields as a browser would submit them (urlencoded). */
function form(fields: Record<string, string | string[]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
  }
  return params.toString();
}

/** The [name, quantity, unit, note] values of the Ingredient rows on a Dish form. */
function ingredientRows(html: string): string[][] {
  const value = (row: string, field: string) => row.match(new RegExp(`name="${field}"[^>]*value="([^"]*)"`))?.[1] ?? "";
  return [...html.matchAll(/<li class="ingredient-row">([\s\S]*?)<\/li>/g)].map((m) => [
    value(m[1]!, "ingredient_name"),
    value(m[1]!, "ingredient_quantity"),
    value(m[1]!, "ingredient_unit"),
    value(m[1]!, "ingredient_note"),
  ]);
}

const urlencoded = { "content-type": "application/x-www-form-urlencoded" };

describe("GET /dishes/new", () => {
  it("offers the Main Category from the fixed list of 11", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/dishes/new" });

    expect(res.statusCode).toBe(200);
    const options = [...res.body.matchAll(/<option value="([a-z]*)"/g)].map((m) => m[1]);
    expect(options).toEqual(["", ...MAIN_CATEGORY_KEYS]);
  });

  it("labels the save button with its working label in sv and en", async () => {
    const app = await start();
    const sv = await app.inject({ method: "GET", url: "/dishes/new", headers: { cookie: "lang=sv" } });
    expect(sv.body).toMatch(/<button type="submit" class="primary" data-working-label="Sparar…">Spara<\/button>/);
    const en = await app.inject({ method: "GET", url: "/dishes/new", headers: { cookie: "lang=en" } });
    expect(en.body).toMatch(/<button type="submit" class="primary" data-working-label="Saving…">Save<\/button>/);
  });

  it("starts a new dish in rotation", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/dishes/new" });

    expect(res.body).toMatch(/name="in_rotation" value="1" checked/);
    expect(res.body).not.toMatch(/name="weekend_only" value="1" checked/);
  });
});

const fullTacosForm = {
  name: "Tacos <fredag>",
  recipe_url: "https://example.com/tacos",
  adaptation_notes: "no chili - the kids",
  prep_time_minutes: "25",
  main_category: "tacos",
  in_rotation: "1",
  preferred_days: ["fri", "sat"],
  weekend_only: "1",
  ingredient_name: ["minced beef", "tortillas", "salsa"],
  ingredient_quantity: ["500", "8", ""],
  ingredient_unit: ["g", "", ""],
  ingredient_note: ["browned", "", ""],
};

async function createViaForm(app: Awaited<ReturnType<typeof buildApp>>, fields: Record<string, string | string[]>) {
  const res = await app.inject({ method: "POST", url: "/dishes", headers: urlencoded, payload: form(fields) });
  expect(res.statusCode).toBe(303);
  expect(res.headers.location).toBe("/dishes");
  const list = await app.inject({ method: "GET", url: "/dishes" });
  const match = list.body.match(/href="\/dishes\/(\d+)\/edit"/);
  if (!match) throw new Error("no dish link on the list page");
  return Number(match[1]);
}

describe("POST /dishes then GET /dishes/:id/edit", () => {
  it("reloads a dish saved with every field with the same values", async () => {
    const app = await start();

    const id = await createViaForm(app, fullTacosForm);
    const res = await app.inject({ method: "GET", url: `/dishes/${id}/edit` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="name" required value="Tacos &lt;fredag&gt;"');
    expect(res.body).toContain('name="recipe_url" type="url" value="https://example.com/tacos"');
    expect(res.body).toContain('value="25"');
    expect(res.body).toContain('<option value="tacos" selected>');
    expect(res.body).toContain('name="adaptation_notes" rows="2">no chili - the kids</textarea>');
    expect(ingredientRows(res.body)).toEqual([
      ["minced beef", "500", "g", "browned"],
      ["tortillas", "8", "", ""],
      ["salsa", "", "", ""],
    ]);
    expect(getDish(app.ctx.db, id)?.ingredients[0]).toEqual({ name: "minced beef", quantity: 500, unit: "g", preparationNote: "browned" });
    expect(res.body).toMatch(/name="in_rotation" value="1" checked/);
    expect(res.body).toMatch(/name="weekend_only" value="1" checked/);
    const checkedDays = [...res.body.matchAll(/name="preferred_days" value="(\w+)" checked/g)].map((m) => m[1]);
    expect(checkedDays).toEqual(["fri", "sat"]);
  });

  it("lists the dish with its name escaped", async () => {
    const app = await start();

    await createViaForm(app, fullTacosForm);
    const res = await app.inject({ method: "GET", url: "/dishes" });

    expect(res.body).toContain("Tacos &lt;fredag&gt;");
    expect(res.body).not.toContain("<fredag>");
  });

  it("rejects a Main Category outside the fixed list", async () => {
    const app = await start();

    const res = await app.inject({
      method: "POST",
      url: "/dishes",
      headers: urlencoded,
      payload: form({ name: "Sushi", main_category: "sushi" }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Main Category");
    expect((await app.inject({ method: "GET", url: "/dishes" })).body).toContain("No dishes yet");
  });

  it("rejects a missing name", async () => {
    const app = await start();

    const res = await app.inject({ method: "POST", url: "/dishes", headers: urlencoded, payload: form({ name: "  " }) });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Name is required");
  });
});

describe("POST /dishes/:id", () => {
  it("takes a dish out of rotation and clears unchecked fields", async () => {
    const app = await start();
    const id = await createViaForm(app, fullTacosForm);

    const res = await app.inject({
      method: "POST",
      url: `/dishes/${id}`,
      headers: urlencoded,
      payload: form({ name: "Tacos", main_category: "" }),
    });

    expect(res.statusCode).toBe(303);
    const edit = await app.inject({ method: "GET", url: `/dishes/${id}/edit` });
    expect(edit.body).toContain('name="name" required value="Tacos"');
    expect(edit.body).not.toMatch(/name="in_rotation" value="1" checked/);
    expect(edit.body).not.toMatch(/name="weekend_only" value="1" checked/);
    expect(edit.body).not.toMatch(/name="preferred_days" value="\w+" checked/);
    expect(edit.body).toContain('<option value="" selected>');
    expect(ingredientRows(edit.body)).toEqual([]);
  });

  it("returns 404 for an unknown dish", async () => {
    const app = await start();

    const res = await app.inject({ method: "POST", url: "/dishes/999", headers: urlencoded, payload: form({ name: "X" }) });

    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/dishes/999/edit" })).statusCode).toBe(404);
  });
});

describe("LLM Main Category proposal on save (FR-1)", () => {
  const fish = () => new ScriptedLlmAgent({ suggestMainCategory: { ok: true, value: "fish" } });

  it("stores the agent's suggestion when a new Dish is saved without a category", async () => {
    const llm = fish();
    const app = await start(llm);

    await app.inject({ method: "POST", url: "/dishes", headers: urlencoded, payload: form({ name: "Fiskgratäng", main_category: "" }) });

    expect(listDishes(app.ctx.db)[0]?.mainCategory).toBe("fish");
    expect(llm.calls[0]).toMatchObject({ method: "suggestMainCategory", args: ["Fiskgratäng", [...MAIN_CATEGORY_KEYS]] });
  });

  it("keeps a category the user chose and does not ask the agent", async () => {
    const llm = fish();
    const app = await start(llm);

    await app.inject({ method: "POST", url: "/dishes", headers: urlencoded, payload: form({ name: "X", main_category: "pasta" }) });

    expect(listDishes(app.ctx.db)[0]?.mainCategory).toBe("pasta");
    expect(llm.calls).toHaveLength(0);
  });

  it("proposes on edit when the category is blank, but respects an explicit clear (main_category_touched)", async () => {
    const app = await start(fish());
    const created = await app.inject({ method: "POST", url: "/dishes", headers: urlencoded, payload: form({ name: "Fiskgratäng" }) });
    expect(created.statusCode).toBe(303);
    const id = listDishes(app.ctx.db)[0]!.id;

    const edit = await app.inject({ method: "GET", url: `/dishes/${id}/edit` });
    expect(edit.body).toContain('name="main_category_touched" value="1"');

    await app.inject({ method: "POST", url: `/dishes/${id}`, headers: urlencoded, payload: form({ name: "Fiskgratäng", main_category: "", main_category_touched: "1" }) });
    expect(listDishes(app.ctx.db)[0]?.mainCategory).toBeNull();

    await app.inject({ method: "POST", url: `/dishes/${id}`, headers: urlencoded, payload: form({ name: "Fiskgratäng", main_category: "tacos", main_category_touched: "1" }) });
    expect(listDishes(app.ctx.db)[0]?.mainCategory).toBe("tacos");
  });

  it("leaves the category empty when the agent fails or is not configured", async () => {
    const failing = await start(new ScriptedLlmAgent({ suggestMainCategory: { ok: false, reason: "boom" } }));
    const none = await start();

    for (const app of [failing, none]) {
      const res = await app.inject({ method: "POST", url: "/dishes", headers: urlencoded, payload: form({ name: "Fiskgratäng" }) });
      expect(res.statusCode).toBe(303);
      expect(listDishes(app.ctx.db)[0]?.mainCategory).toBeNull();
    }
  });
});

describe("deleting a Dish", () => {
  it("offers delete only at the bottom of the edit page, never on the list", async () => {
    const app = await start();
    const id = await createViaForm(app, fullTacosForm);

    const list = (await app.inject({ method: "GET", url: "/dishes" })).body;
    const edit = (await app.inject({ method: "GET", url: `/dishes/${id}/edit` })).body;

    expect(list).not.toContain("/delete");
    expect(edit).toContain(`href="/dishes/${id}/delete"`);
  });

  it("asks for confirmation on GET and deletes only on the confirming POST", async () => {
    const app = await start();
    const id = await createViaForm(app, fullTacosForm);

    const ask = await app.inject({ method: "GET", url: `/dishes/${id}/delete` });
    expect(ask.statusCode).toBe(200);
    expect(ask.body).toContain("Delete Tacos &lt;fredag&gt;?");
    expect(getDish(app.ctx.db, id)).toBeDefined();

    const unconfirmed = await app.inject({ method: "POST", url: `/dishes/${id}/delete` });
    expect(unconfirmed.statusCode).toBe(303);
    expect(unconfirmed.headers.location).toBe(`/dishes/${id}/delete`);
    expect(getDish(app.ctx.db, id)).toBeDefined();

    const res = await app.inject({ method: "POST", url: `/dishes/${id}/delete`, headers: urlencoded, payload: form({ confirm: "1" }) });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/dishes");
    expect((await app.inject({ method: "GET", url: "/dishes" })).body).toContain("No dishes yet");
  });

  it("returns 404 when confirming an unknown Dish", async () => {
    const app = await start();
    expect((await app.inject({ method: "GET", url: "/dishes/999/delete" })).statusCode).toBe(404);
  });
});

describe("the Dishes list sections", () => {
  it("splits Favoriter from Förslag and offers promote only in Förslag", async () => {
    const app = await start();
    createDish(app.ctx.db, { name: "Tacos", mainCategory: "tacos", prepTimeMinutes: 25 });
    const id = createDish(app.ctx.db, { name: "Köttbullar", inRotation: false, suggested: true });

    const html = (await app.inject({ method: "GET", url: "/dishes" })).body;
    const [favorites, suggestions] = html.split('id="suggestions"') as [string, string];

    expect(favorites).toContain("Favorites");
    expect(favorites).toContain("Tacos");
    expect(favorites).toContain("25 min");
    expect(favorites).not.toContain("Köttbullar");
    expect(favorites).not.toContain("/promote");
    expect(suggestions).toContain("Köttbullar");
    expect(suggestions).toContain(`/dishes/${id}/promote`);
    expect(suggestions).not.toContain("Tacos");
  });

  it("renders in Swedish", async () => {
    const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-dishes-sv-")) });
    apps.push(app);
    createDish(app.ctx.db, { name: "Köttbullar", inRotation: false, suggested: true });

    const html = (await app.inject({ method: "GET", url: "/dishes", headers: { cookie: "lang=sv" } })).body;

    expect(html).toContain("Favoriter");
    expect(html).toContain("Förslag");
    expect(html).toContain("Lägg till i favoriter");
  });
});

describe("Ingredient rows (HTMX)", () => {
  it("serves a blank row fragment for add row", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/dishes/ingredient-row" });

    expect(res.statusCode).toBe(200);
    expect(ingredientRows(res.body)).toEqual([["", "", "", ""]]);
    expect(res.body).not.toContain("<html");
  });

  it("wires add row on the form and renders Preferred Days as chips", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/dishes/new" });

    expect(res.body).toContain('hx-get="/dishes/ingredient-row"');
    expect(res.body).toContain('class="chip"');
    expect(res.body).not.toContain('name="ingredients"');
  });

  it("drops rows without a name and accepts a Swedish decimal comma", async () => {
    const app = await start();
    const id = await createViaForm(app, {
      name: "Pasta",
      ingredient_name: ["cream", ""],
      ingredient_quantity: ["2,5", "3"],
      ingredient_unit: ["dl", ""],
      ingredient_note: ["", ""],
    });

    expect(getDish(app.ctx.db, id)?.ingredients).toEqual([{ name: "cream", quantity: 2.5, unit: "dl" }]);
  });

  it("rejects a quantity that is not a number", async () => {
    const app = await start();
    const res = await app.inject({
      method: "POST",
      url: "/dishes",
      headers: urlencoded,
      payload: form({ name: "X", ingredient_name: "salt", ingredient_quantity: "a pinch", ingredient_unit: "", ingredient_note: "" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Quantity");
  });
});

describe("Suggested Dishes", () => {
  it("marks only Suggested Dishes on the Dishes page and offers promote for them", async () => {
    const app = await start();
    const id = createDish(app.ctx.db, { name: "Köttbullar", inRotation: false, suggested: true });
    createDish(app.ctx.db, { name: "Tacos" });

    const html = (await app.inject({ method: "GET", url: "/dishes" })).body;

    expect(html.match(/Add to favorites/g)).toHaveLength(1);
    expect(html).toContain(`/dishes/${id}/promote`);
  });

  it("promotes a Dish into rotation and redirects back to the Referer", async () => {
    const app = await start();
    const id = createDish(app.ctx.db, { name: "Köttbullar", inRotation: false, suggested: true });

    const res = await app.inject({ method: "POST", url: `/dishes/${id}/promote`, headers: { referer: "/plan" } });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/plan");
    expect(getDish(app.ctx.db, id)).toMatchObject({ inRotation: true, suggested: false });
  });

  it("redirects to /dishes without a Referer", async () => {
    const app = await start();
    const id = createDish(app.ctx.db, { name: "X", inRotation: false, suggested: true });
    const res = await app.inject({ method: "POST", url: `/dishes/${id}/promote` });
    expect(res.headers.location).toBe("/dishes");
  });

  it("keeps the flag when the edit form saves a Suggested Dish", async () => {
    const app = await start();
    const id = createDish(app.ctx.db, { name: "Köttbullar", inRotation: false, suggested: true });

    await app.inject({
      method: "POST",
      url: `/dishes/${id}`,
      headers: urlencoded,
      payload: form({ name: "Köttbullar", main_category_touched: "1" }),
    });

    expect(getDish(app.ctx.db, id)?.suggested).toBe(true);
  });
  it("clears the flag when the edit form puts a Suggested Dish in rotation", async () => {
    const app = await start();
    const id = createDish(app.ctx.db, { name: "Köttbullar", inRotation: false, suggested: true });

    await app.inject({
      method: "POST",
      url: `/dishes/${id}`,
      headers: urlencoded,
      payload: form({ name: "Köttbullar", main_category_touched: "1", in_rotation: "1" }),
    });

    expect(getDish(app.ctx.db, id)).toMatchObject({ inRotation: true, suggested: false });
  });

  it("returns 404 when promoting an unknown Dish", async () => {
    const app = await start();
    const res = await app.inject({ method: "POST", url: "/dishes/999/promote", headers: { referer: "/plan" } });
    expect(res.statusCode).toBe(404);
  });

  it.each([
    ["an absolute same-site URL", "http://localhost/plan?week=2026-10-12", "/plan?week=2026-10-12"],
    ["another site", "https://evil.example/phish", "/dishes"],
    ["a protocol-relative URL", "//evil.example/phish", "/dishes"],
    ["a same-site URL with a double-slash path", "http://localhost//evil.example/phish", "/dishes"],
    ["a relative path", "plan", "/dishes"],
  ])("follows a Referer of %s only to a same-site path", async (_label, referer, location) => {
    const app = await start();
    const id = createDish(app.ctx.db, { name: "X", inRotation: false, suggested: true });
    const res = await app.inject({ method: "POST", url: `/dishes/${id}/promote`, headers: { referer, host: "localhost" } });
    expect(res.headers.location).toBe(location);
  });
});
