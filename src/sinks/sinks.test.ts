import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { writeSetting } from "../db.js";
import { createDish } from "../dishes/repo.js";
import { NoAgent } from "../llm/index.js";
import { createPantryItem } from "../pantry/repo.js";
import { savePlan } from "../planner/repo.js";
import { SETTING_SHOPPING_LIST_SINKS } from "../planner/settings.js";
import { buildShoppingList } from "../shopping/build.js";
import { pushShoppingList } from "./push.js";
import { configuredSinks } from "./registry.js";
import { createTrelloSink, trelloSinkFromEnv } from "./trello.js";
import type { FetchLike } from "./types.js";

const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";
const ENV = { TRELLO_KEY: "k", TRELLO_TOKEN: "t0ken", TRELLO_BOARD_ID: "b1" };

function recorder(failOn?: (url: string) => boolean) {
  const calls: { url: string; method?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, ...(init?.method ? { method: init.method } : {}) });
    if (failOn?.(url)) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ id: "list1" }) };
  };
  return { calls, fetch };
}

describe("Trello sink", () => {
  it("creates a list named by the Monday and one card per item", async () => {
    const { calls, fetch } = recorder();
    const sink = createTrelloSink({ key: "k", token: "t", boardId: "b1", fetch });

    const result = await sink.push({
      weekStart: WEEK,
      items: [
        { name: "pasta", quantity: "400", unit: "g", sourceDishIds: [1] },
        { name: "salt", quantity: null, unit: null, sourceDishIds: [1] },
      ],
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toContain("/1/boards/b1/lists?");
    expect(calls[0]!.url).toContain("name=Shopping+2026-10-19");
    expect(calls[1]!.url).toContain("/1/cards?");
    expect(calls[1]!.url).toContain("idList=list1");
    expect(calls[1]!.url).toContain("name=400+g+pasta");
    expect(calls[2]!.url).toContain("name=salt&");
    expect(calls.every((c) => c.method === "POST")).toBe(true);
  });

  it("returns an error (no secrets) instead of throwing on HTTP or network failure", async () => {
    const http = createTrelloSink({ key: "k", token: "t0ken", boardId: "b1", fetch: recorder(() => true).fetch });
    const net = createTrelloSink({ key: "k", token: "t0ken", boardId: "b1", fetch: async () => { throw new Error("down t0ken"); } });

    const a = await http.push({ weekStart: WEEK, items: [] });
    const b = await net.push({ weekStart: WEEK, items: [] });

    expect(a).toMatchObject({ ok: false });
    expect(b).toMatchObject({ ok: false });
    expect(JSON.stringify(b)).not.toContain("t0ken");
  });

  it("is null from env unless all three variables are set", () => {
    expect(trelloSinkFromEnv({})).toBeNull();
    expect(trelloSinkFromEnv({ TRELLO_KEY: "k", TRELLO_TOKEN: "t" })).toBeNull();
    expect(trelloSinkFromEnv(ENV)?.id).toBe("trello");
  });
});

describe("configuredSinks", () => {
  async function db() {
    const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-sinks-")), llm: new NoAgent(), env: {} });
    apps.push(app);
    return app.ctx.db;
  }

  it("defaults to Trello when env is set, none otherwise", async () => {
    const d = await db();
    expect(configuredSinks(d, ENV).map((s) => s.id)).toEqual(["trello"]);
    expect(configuredSinks(d, {})).toEqual([]);
  });

  it("reads the setting; unknown types and malformed JSON are ignored", async () => {
    const d = await db();
    writeSetting(d, SETTING_SHOPPING_LIST_SINKS, '[{"type":"trello"},{"type":"nope"}]');
    expect(configuredSinks(d, ENV).map((s) => s.id)).toEqual(["trello"]);
    writeSetting(d, SETTING_SHOPPING_LIST_SINKS, "[]");
    expect(configuredSinks(d, ENV).map((s) => s.id)).toEqual(["trello"]);
    writeSetting(d, SETTING_SHOPPING_LIST_SINKS, "{bad");
    expect(configuredSinks(d, {})).toEqual([]);
  });
});

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function planWithList(fetch: FetchLike) {
  const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-push-")), now: () => NOW, llm: new NoAgent(), env: ENV, fetch });
  apps.push(app);
  const db = app.ctx.db;
  const dish = createDish(db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "mjölk", quantity: 2, unit: "dl" }] });
  createPantryItem(db, { name: "mjölk", aliases: [] });
  const planId = savePlan(
    db,
    { weekStart: WEEK, dinners: [{ date: WEEK, dishId: dish, isQuickDay: false, lunchThatDay: null, rationale: "r" }], degradedReasons: [] },
    NOW.toISOString(),
  );
  await buildShoppingList(app.ctx, planId);
  return { app, planId };
}

describe("pushShoppingList", () => {
  it("pushes only the Buy section and records the result", async () => {
    const { calls, fetch } = recorder();
    const { app, planId } = await planWithList(fetch);

    await pushShoppingList({ db: app.ctx.db, env: ENV, fetch }, planId);

    const cards = calls.filter((c) => c.url.includes("/cards?"));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.url).toContain("name=400+g+pasta");
    expect(calls.some((c) => c.url.includes("mj"))).toBe(false);
    const row = app.ctx.db.prepare("SELECT sink_id, ok, error FROM sink_push WHERE plan_id = ?").get(planId);
    expect(row).toEqual({ sink_id: "trello", ok: 1, error: null });
  });

  it("failed push is recorded, shown on GET /shopping, and leaves the plan untouched", async () => {
    const { fetch } = recorder(() => true);
    const { app, planId } = await planWithList(fetch);
    const before = JSON.stringify(app.ctx.db.prepare("SELECT * FROM planned_dinner").all()) + JSON.stringify(app.ctx.db.prepare("SELECT * FROM weekly_plan").all());

    const res = await app.inject({ method: "POST", url: "/shopping/push", payload: `weekStart=${WEEK}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(res.statusCode).toBe(303);

    const page = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });
    expect(page.body).toContain("Trello HTTP 401");
    expect(page.body).toContain('action="/shopping/push"');
    const after = JSON.stringify(app.ctx.db.prepare("SELECT * FROM planned_dinner").all()) + JSON.stringify(app.ctx.db.prepare("SELECT * FROM weekly_plan").all());
    expect(after).toBe(before);
    expect(planId).toBeGreaterThan(0);
  });

  it("does not throw for an unknown plan or with no sinks", async () => {
    const { app } = await planWithList(recorder().fetch);
    await expect(pushShoppingList({ db: app.ctx.db, env: {} }, 9999)).resolves.toBeUndefined();
  });
});
