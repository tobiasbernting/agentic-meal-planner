import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { readSetting, writeSetting } from "../db.js";
import { createDish } from "../dishes/repo.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { createList } from "../lists/repo.js";
import { createTodo, getTodo, tickTodo, updateTodo, type TodoInput } from "../lists/todos.js";
import { NoAgent } from "../llm/index.js";
import { upsertLunchEntry } from "../lunch/repo.js";
import { createMember } from "../members/repo.js";
import { SETTING_SHOPPING_LIST_SINKS } from "../planner/settings.js";
import { savePlan } from "../planner/repo.js";
import { householdTick, type HouseholdTickState } from "../scheduler/household-tick.js";
import { createSchool } from "../schools/repo.js";
import { addLine, checkLine } from "../shopping/edits.js";
import type { FetchLike } from "../sinks/types.js";
import { topicUrl } from "../sinks/webhook.js";
import { dailyBrief } from "./brief.js";
import { SETTING_DAILY_BRIEF_TIME } from "./send.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// Wednesday 2026-10-21, local time.
const at = (h: number, m: number) => new Date(2026, 9, 21, h, m);
const TODAY = "2026-10-21";
const NTFY = "https://ntfy.example/familjen";

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

type Call = { url: string; headers: Record<string, string>; body: string };

async function household() {
  let now = at(6, 0);
  const app = withEnglish(await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-notifier-")), now: () => now, llm: new NoAgent() }));
  apps.push(app);
  const db = app.ctx.db;
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body ?? "" });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const state: HouseholdTickState = {};
  const tick = async (h: number, m: number) => {
    now = at(h, m);
    await householdTick({ db, now: () => now, env: {}, fetch }, state);
  };
  const chores = createList(db, "Att göra", "todo", at(6, 0).toISOString());
  const add = (input: TodoInput) => createTodo(db, chores.id, input, at(6, 0).toISOString(), null);
  return { app, db, calls, tick, add };
}

function withSink(db: Parameters<typeof writeSetting>[0], format: "ntfy" | "json" = "ntfy") {
  writeSetting(db, SETTING_SHOPPING_LIST_SINKS, JSON.stringify([{ type: "webhook", url: NTFY, format }]));
}

function decodeTitle(header: string | undefined): string {
  const m = /^=\?UTF-8\?B\?(.*)\?=$/.exec(header ?? "");
  return m ? Buffer.from(m[1]!, "base64").toString("utf8") : (header ?? "");
}

async function scripted(db: Parameters<typeof writeSetting>[0]) {
  const school = createSchool(db, { name: "Norra skolan", url: "https://school.example" });
  upsertLunchEntry(db, { schoolId: school.id, date: TODAY, rawText: "Fiskgratäng\nPotatis", fetchedAt: at(6, 0).toISOString() });
  const dishId = createDish(db, { name: "Pasta pesto" });
  savePlan(db, { weekStart: "2026-10-19", dinners: [{ date: TODAY, dishId, isQuickDay: false, lunchThatDay: null, rationale: "" }], degradedReasons: [] }, at(6, 0).toISOString());
  addLine(db, { name: "mjölk" }, at(6, 0).toISOString());
  addLine(db, { name: "ost" }, at(6, 0).toISOString());
  const bröd = addLine(db, { name: "bröd" }, at(6, 0).toISOString());
  checkLine(db, bröd.id, at(6, 1).toISOString());
}

describe("dailyBrief", () => {
  it("renders lunch, dinner, due and overdue Todos with Members, and the Buy count, in sv and en", async () => {
    const { db, add } = await household();
    await scripted(db);
    const ella = createMember(db, { name: "Ella", colour: "berry" });
    add({ title: "Hämta paket", dueDate: "2026-10-20" });
    add({ title: "Tandläkare", dueDate: TODAY, dueTime: "15:00", member: { id: ella.id, name: ella.name } });
    add({ title: "Imorgon", dueDate: "2026-10-22" });

    expect(dailyBrief(db, "sv", TODAY)).toEqual({
      title: "Idag, ons 21 okt",
      text: "Lunch · Norra skolan: Fiskgratäng · Potatis\n\nMiddag: Pasta pesto\n\nAtt göra:\n- Hämta paket (försenad)\n- Tandläkare 15:00 (Ella)\n\n2 rader kvar att köpa",
    });
    expect(dailyBrief(db, "en", TODAY)).toEqual({
      title: "Today, wed 21 Oct",
      text: "Lunch · Norra skolan: Fiskgratäng · Potatis\n\nDinner: Pasta pesto\n\nTo do:\n- Hämta paket (overdue)\n- Tandläkare 15:00 (Ella)\n\n2 lines left to buy",
    });
  });

  it("omits empty sections, and has nothing to say on an empty day", async () => {
    const { db, add } = await household();
    expect(dailyBrief(db, "sv", TODAY)).toBeUndefined();
    add({ title: "Vattna", dueDate: TODAY });
    expect(dailyBrief(db, "sv", TODAY)).toEqual({ title: "Idag, ons 21 okt", text: "Att göra:\n- Vattna" });
  });
});

describe("the Daily Brief through the webhook sink", () => {
  it("goes out once at the configured minute, as ntfy title and body", async () => {
    const { db, calls, tick, add } = await household();
    withSink(db);
    writeSetting(db, SETTING_DAILY_BRIEF_TIME, "07:00");
    add({ title: "Vattna", dueDate: TODAY });

    await tick(6, 59);
    expect(calls).toEqual([]);
    await tick(7, 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(NTFY);
    expect(decodeTitle(calls[0]!.headers.Title)).toBe("Idag, ons 21 okt");
    expect(calls[0]!.body).toBe("Att göra:\n- Vattna");
    await tick(7, 0);
    await tick(7, 1);
    expect(calls).toHaveLength(1);
  });

  it("sends nothing when the setting is empty or no sink is configured", async () => {
    const { db, calls, tick, add } = await household();
    add({ title: "Vattna", dueDate: TODAY });
    writeSetting(db, SETTING_DAILY_BRIEF_TIME, "07:00");
    await tick(7, 0);
    expect(calls).toEqual([]);

    const other = await household();
    withSink(other.db);
    other.add({ title: "Vattna", dueDate: TODAY });
    await other.tick(7, 0);
    expect(other.calls).toEqual([]);
  });

  it("sends the json shape to a json webhook", async () => {
    const { db, calls, tick, add } = await household();
    withSink(db, "json");
    writeSetting(db, SETTING_DAILY_BRIEF_TIME, "07:00");
    add({ title: "Vattna", dueDate: TODAY });
    await tick(7, 0);
    expect(JSON.parse(calls[0]!.body)).toEqual({ kind: "notice", title: "Idag, ons 21 okt", text: "Att göra:\n- Vattna" });
  });
});

describe("Due messages", () => {
  it("fires once in the Due minute's tick, with a second copy to the Member's topic", async () => {
    const { db, calls, tick, add } = await household();
    withSink(db);
    const ella = createMember(db, { name: "Ella", colour: "berry", topic: "ella-telefon" });
    const todo = add({ title: "Hämta Ella", dueDate: TODAY, dueTime: "15:00", member: { id: ella.id, name: ella.name } });
    add({ title: "Utan tid", dueDate: TODAY });

    await tick(14, 59);
    expect(calls).toEqual([]);
    await tick(15, 0);
    expect(calls.map((c) => [c.url, decodeTitle(c.headers.Title), c.body])).toEqual([
      [NTFY, "Hämta Ella", "Senast 15:00 · Att göra · Ella"],
      ["https://ntfy.example/ella-telefon", "Hämta Ella", "Senast 15:00 · Att göra · Ella"],
    ]);
    await tick(15, 1);
    expect(calls).toHaveLength(2);
    expect(getTodo(db, todo.id)).toBeDefined();
  });

  it("skips Done Todos and old Due times, and fires again after a repeating Todo advances or the Due changes", async () => {
    const { db, calls, tick, add } = await household();
    withSink(db);
    const done = add({ title: "Klar", dueDate: TODAY, dueTime: "09:00" });
    tickTodo(db, done.id, at(8, 0).toISOString(), TODAY, undefined);
    add({ title: "Länge sedan", dueDate: TODAY, dueTime: "08:00" });
    await tick(9, 0);
    expect(calls).toEqual([]);

    const repeating = add({ title: "Soptunnan", dueDate: TODAY, dueTime: "10:00", repeat: { kind: "daily" } });
    await tick(10, 0);
    expect(calls).toHaveLength(1);
    tickTodo(db, repeating.id, at(10, 5).toISOString(), TODAY, undefined);
    expect(getTodo(db, repeating.id)!.dueDate).toBe("2026-10-22");

    const moved = add({ title: "Flyttad", dueDate: TODAY, dueTime: "11:00" });
    await tick(11, 0);
    updateTodo(db, moved.id, { title: "Flyttad", dueDate: TODAY, dueTime: "12:00" });
    await tick(12, 0);
    expect(calls.map((c) => decodeTitle(c.headers.Title))).toEqual(["Soptunnan", "Flyttad", "Flyttad"]);
  });
});

describe("topicUrl", () => {
  it("swaps the last path segment, or takes a full URL as is", () => {
    expect(topicUrl("https://ntfy.sh/familjen", "pappa")).toBe("https://ntfy.sh/pappa");
    expect(topicUrl("https://ntfy.example/sub/familjen", "pappa")).toBe("https://ntfy.example/sub/pappa");
    expect(topicUrl("https://ntfy.sh/familjen", "https://other.example/x")).toBe("https://other.example/x");
  });
});

describe("Settings: Notices", () => {
  const base = { cron_expression: "0 18 * * 0", shopping_list_sinks: "[]", variety_window_weeks: "3", default_prep_limit_minutes: "30" };

  it("shows the field, saves it with the notice language, refuses a bad time, and says when no recipient is set", async () => {
    const { app, db } = await household();
    let html = (await app.inject({ method: "GET", url: "/settings" })).body;
    expect(html).toContain('<input type="time" name="daily_brief_time" value="" />');
    expect(html).toContain('<p class="no-sink">No recipient set. <a href="#recipients">Set a recipient</a></p>');

    expect((await app.inject({ method: "POST", url: "/settings", payload: { ...base, daily_brief_time: "7am" } })).statusCode).toBe(400);
    const saved = await app.inject({ method: "POST", url: "/settings", headers: { cookie: "lang=en" }, payload: { ...base, daily_brief_time: "07:15", webhook_url: NTFY, webhook_format: "ntfy" } });
    expect(saved.statusCode).toBe(303);
    expect(readSetting(db, SETTING_DAILY_BRIEF_TIME)).toBe("07:15");
    expect(readSetting(db, "notice_lang")).toBe("en");

    html = (await app.inject({ method: "GET", url: "/settings" })).body;
    expect(html).toContain('<input type="time" name="daily_brief_time" value="07:15" />');
    expect(html).not.toContain("no-sink");
    const sv = (await app.inject({ method: "GET", url: "/settings", headers: { cookie: "lang=sv" } })).body;
    expect(sv).toContain("<h2>Meddelanden</h2>");

    // A post without the field keeps the stored time; an empty one turns it off.
    await app.inject({ method: "POST", url: "/settings", payload: { ...base } });
    expect(readSetting(db, SETTING_DAILY_BRIEF_TIME)).toBe("07:15");
    await app.inject({ method: "POST", url: "/settings", payload: { ...base, daily_brief_time: "" } });
    expect(readSetting(db, SETTING_DAILY_BRIEF_TIME)).toBe("");
  });
});
