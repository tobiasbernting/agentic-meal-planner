import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { MAIN_CATEGORY_KEYS } from "./categories.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function start() {
  const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-dishes-http-")) });
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

const urlencoded = { "content-type": "application/x-www-form-urlencoded" };

describe("GET /dishes/new", () => {
  it("offers the Main Category from the fixed list of 11 and shows Dishes in the nav", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/dishes/new" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<a href="/dishes">Dishes</a>');
    const options = [...res.body.matchAll(/<option value="([a-z]*)"/g)].map((m) => m[1]);
    expect(options).toEqual(["", ...MAIN_CATEGORY_KEYS]);
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
  ingredients: "minced beef | 500 | g\ntortillas | 8\nsalsa",
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
    expect(res.body).toContain("minced beef | 500 | g\ntortillas | 8\nsalsa</textarea>");
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
      payload: form({ name: "Tacos", main_category: "", ingredients: "" }),
    });

    expect(res.statusCode).toBe(303);
    const edit = await app.inject({ method: "GET", url: `/dishes/${id}/edit` });
    expect(edit.body).toContain('name="name" required value="Tacos"');
    expect(edit.body).not.toMatch(/name="in_rotation" value="1" checked/);
    expect(edit.body).not.toMatch(/name="weekend_only" value="1" checked/);
    expect(edit.body).not.toMatch(/name="preferred_days" value="\w+" checked/);
    expect(edit.body).toContain('<option value="" selected>');
    expect(edit.body).toContain('name="ingredients" rows="6"></textarea>');
  });

  it("returns 404 for an unknown dish", async () => {
    const app = await start();

    const res = await app.inject({ method: "POST", url: "/dishes/999", headers: urlencoded, payload: form({ name: "X" }) });

    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/dishes/999/edit" })).statusCode).toBe(404);
  });
});

describe("POST /dishes/:id/delete", () => {
  it("removes the dish from the list", async () => {
    const app = await start();
    const id = await createViaForm(app, fullTacosForm);

    const res = await app.inject({ method: "POST", url: `/dishes/${id}/delete` });

    expect(res.statusCode).toBe(303);
    expect((await app.inject({ method: "GET", url: "/dishes" })).body).toContain("No dishes yet");
  });
});
