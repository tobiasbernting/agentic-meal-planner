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
import { updateShoppingList } from "../shopping/shares.js";
import { pushShoppingList } from "./push.js";
import type { FetchLike } from "./types.js";
import { createWebhookSink } from "./webhook.js";

const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";
const URL = "https://ntfy.example/shopping";
const ITEMS = [
  { name: "pasta", quantity: "400", unit: "g", sourceDishIds: [1] },
  { name: "salt", quantity: null, unit: null, sourceDishIds: [1] },
];

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: string };
function recorder(status = 200) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, ...init });
    return { ok: status < 400, status, json: async () => ({}) };
  };
  return { calls, fetch };
}

describe("webhook sink", () => {
  it("ntfy (default): POSTs plain text, one line per item, with a Title header", async () => {
    const { calls, fetch } = recorder();
    const result = await createWebhookSink({ url: URL, fetch }).push({ weekStart: WEEK, items: ITEMS });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: URL, method: "POST", body: "400 g pasta\nsalt" });
    expect(calls[0]!.headers).toMatchObject({ Title: "Shopping 2026-10-19" });
    expect(calls[0]!.headers!.Authorization).toBeUndefined();
  });

  it("json: POSTs { weekStart, items }", async () => {
    const { calls, fetch } = recorder();
    await createWebhookSink({ url: URL, format: "json", fetch }).push({ weekStart: WEEK, items: ITEMS });

    expect(calls[0]!.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ weekStart: WEEK, items: ITEMS });
  });

  it("sends a bearer secret when given", async () => {
    const { calls, fetch } = recorder();
    await createWebhookSink({ url: URL, secret: "s3cret", fetch }).push({ weekStart: WEEK, items: ITEMS });
    expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer s3cret" });
  });

  it("returns { ok: false } on HTTP or network failure, never throws, never leaks the secret", async () => {
    const http = await createWebhookSink({ url: URL, secret: "s3cret", fetch: recorder(500).fetch }).push({ weekStart: WEEK, items: ITEMS });
    const net = await createWebhookSink({
      url: URL,
      secret: "s3cret",
      fetch: async () => {
        throw new Error("down s3cret");
      },
    }).push({ weekStart: WEEK, items: ITEMS });

    expect(http).toMatchObject({ ok: false });
    expect(net).toMatchObject({ ok: false });
    expect(JSON.stringify(net)).not.toContain("s3cret");
  });
});

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function planWithList(env: Record<string, string>, fetch: FetchLike) {
  const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-webhook-")), now: () => NOW, llm: new NoAgent(), env, fetch });
  apps.push(app);
  const db = app.ctx.db;
  const dish = createDish(db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "mjölk", quantity: 2, unit: "dl" }] });
  createPantryItem(db, { name: "mjölk", aliases: [] });
  const planId = savePlan(
    db,
    { weekStart: WEEK, dinners: [{ date: WEEK, dishId: dish, isQuickDay: false, lunchThatDay: null, rationale: "r" }], degradedReasons: [] },
    NOW.toISOString(),
  );
  await updateShoppingList(app.ctx, planId);
  return { app, planId };
}

describe("webhook via settings", () => {
  it("pushes the Buy list to the configured URL, with WEBHOOK_SECRET from env", async () => {
    const { calls, fetch } = recorder();
    const { app, planId } = await planWithList({ WEBHOOK_SECRET: "s3cret" }, fetch);
    writeSetting(app.ctx.db, SETTING_SHOPPING_LIST_SINKS, JSON.stringify([{ type: "webhook", url: URL }]));

    await pushShoppingList({ db: app.ctx.db, env: { WEBHOOK_SECRET: "s3cret" }, fetch }, planId);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: URL, body: "400 g pasta" });
    expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer s3cret" });
  });

  it("a failing webhook shows its error on GET /shopping", async () => {
    const { fetch } = recorder(503);
    const { app, planId } = await planWithList({}, fetch);
    writeSetting(app.ctx.db, SETTING_SHOPPING_LIST_SINKS, JSON.stringify([{ type: "webhook", url: URL, format: "json" }]));

    await pushShoppingList({ db: app.ctx.db, env: {}, fetch }, planId);

    const page = await app.inject({ method: "GET", url: `/shopping?week=${WEEK}` });
    expect(page.body).toContain("Webhook HTTP 503");
  });

  it("an entry without a url is skipped", async () => {
    const { calls, fetch } = recorder();
    const { app, planId } = await planWithList({}, fetch);
    writeSetting(app.ctx.db, SETTING_SHOPPING_LIST_SINKS, JSON.stringify([{ type: "webhook" }]));
    await pushShoppingList({ db: app.ctx.db, env: {}, fetch }, planId);
    expect(calls).toHaveLength(0);
  });

  it("no configured sink (empty setting, no Trello env): no push, nothing recorded", async () => {
    const { calls, fetch } = recorder();
    const { app, planId } = await planWithList({}, fetch);

    await pushShoppingList({ db: app.ctx.db, env: {}, fetch }, planId);

    expect(calls).toHaveLength(0);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM sink_push").get()).toEqual({ n: 0 });
  });
});
