import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createDish } from "../dishes/repo.js";
import { NoAgent } from "../llm/index.js";
import { lineIdOf, planWeek, updateList } from "../shopping/test-helpers.js";
import { writeSetting } from "../db.js";

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];

async function start(options: Partial<AppOptions> = {}) {
  const app = withEnglish(await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-idempotency-")), ...options }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function post(app: App, url: string, payload: Record<string, string>, key?: string) {
  return app.inject({ method: "POST", url, payload, ...(key ? { headers: { "idempotency-key": key } } : {}) });
}

// A Wednesday; its week starts Monday 2026-10-19.
const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";

/** Pasta (pasta) and Gratäng (ost) planned for WEEK, Shopping List updated. Returns the ost line's id. */
async function builtList(app: App): Promise<string> {
  const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }] });
  const gratin = createDish(app.ctx.db, { name: "Gratäng", ingredients: [{ name: "ost", quantity: null, unit: null }] });
  await updateList(app, planWeek(app.ctx.db, WEEK, [pasta, gratin], NOW.toISOString()));
  return lineIdOf((await app.inject({ method: "GET", url: "/shopping" })).body, "ost");
}

/** The labels of struck-through (checked) lines on the Shopping page. */
async function checkedLines(app: App) {
  const res = await app.inject({ method: "GET", url: "/shopping" });
  return [...res.body.matchAll(/<s class="row-label">([^<]*)<\/s>/g)].map((m) => m[1]);
}

async function pantryNames(app: App) {
  const res = await app.inject({ method: "GET", url: "/pantry" });
  return [...res.body.matchAll(/<span class="row-label">([^<]*)<\/span>/g)].map((m) => m[1]);
}

describe("Idempotency-Key on queueable routes", () => {
  it("applies a Pantry Item create once and returns the same redirect for a repeated key", async () => {
    const app = await start();

    const first = await post(app, "/pantry", { name: "milk", aliases: "" }, "key-1");
    const second = await post(app, "/pantry", { name: "milk", aliases: "" }, "key-1");

    expect(first.statusCode).toBe(303);
    expect(second.statusCode).toBe(303);
    expect(second.headers.location).toBe("/pantry");
    expect(second.headers.location).toBe(first.headers.location);
    expect(await pantryNames(app)).toEqual(["milk"]);
  });

  it("replays a Dish edit without running it again", async () => {
    const app = await start();
    const id = createDish(app.ctx.db, { name: "Pasta", ingredients: [] });

    const first = await post(app, `/dishes/${id}`, { name: "Pasta A" }, "key-dish");
    await post(app, `/dishes/${id}`, { name: "Pasta B" });
    const repeat = await post(app, `/dishes/${id}`, { name: "Pasta A" }, "key-dish");
    const list = await app.inject({ method: "GET", url: "/dishes" });

    expect(first.statusCode).toBe(303);
    expect(repeat.statusCode).toBe(303);
    expect(repeat.headers.location).toBe(first.headers.location);
    expect(list.body).toContain("Pasta B");
    expect(list.body).not.toContain("Pasta A");
  });

  it("replays a Shopping check without running it again", async () => {
    const app = await start({ now: () => NOW, llm: new NoAgent() });
    const ost = await builtList(app);

    const first = await post(app, "/shopping/check", { id: ost }, "key-check");
    const afterFirst = await checkedLines(app);
    await post(app, "/shopping/uncheck", { id: ost });
    const repeat = await post(app, "/shopping/check", { id: ost }, "key-check");

    expect(first.statusCode).toBe(303);
    expect(afterFirst).toEqual(["ost"]);
    expect(repeat.headers.location).toBe("/shopping");
    expect(await checkedLines(app)).toEqual([]);
  });

  it("runs every POST without a key, as before", async () => {
    const app = await start();

    await post(app, "/pantry", { name: "milk", aliases: "" });
    await post(app, "/pantry", { name: "milk", aliases: "" });

    expect(await pantryNames(app)).toEqual(["milk", "milk"]);
  });

  it("ignores the key on an online-only route", async () => {
    const sent: string[] = [];
    const fetch = async (url: string) => {
      sent.push(url);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const app = await start({ now: () => NOW, llm: new NoAgent(), fetch });
    await builtList(app);
    writeSetting(app.ctx.db, "shopping_list_sinks", JSON.stringify([{ type: "webhook", url: "https://hook.example/list" }]));

    await post(app, "/shopping/push", {}, "key-push");
    await post(app, "/shopping/push", {}, "key-push");

    expect(sent).toHaveLength(2);
  });

  it("replays a rejected form as the same 400 page with its content type", async () => {
    const app = await start();

    const first = await post(app, "/pantry", { name: " ", aliases: "" }, "key-bad");
    const repeat = await post(app, "/pantry", { name: "milk", aliases: "" }, "key-bad");

    expect(first.statusCode).toBe(400);
    expect(repeat.statusCode).toBe(400);
    expect(repeat.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(repeat.body).toBe(first.body);
    expect(await pantryNames(app)).toEqual([]);
  });

  it("forgets a key after 30 days", async () => {
    let clock = new Date(2026, 9, 1, 12, 0);
    const app = await start({ now: () => clock });
    const day = 24 * 60 * 60 * 1000;

    await post(app, "/pantry", { name: "milk", aliases: "" }, "key-old");
    clock = new Date(clock.getTime() + 29 * day);
    await post(app, "/pantry", { name: "milk", aliases: "" }, "key-old");
    const after29 = await pantryNames(app);
    clock = new Date(clock.getTime() + 2 * day);
    await post(app, "/pantry", { name: "milk", aliases: "" }, "key-old");

    expect(after29).toEqual(["milk"]);
    expect(await pantryNames(app)).toEqual(["milk", "milk"]);
  });
});
