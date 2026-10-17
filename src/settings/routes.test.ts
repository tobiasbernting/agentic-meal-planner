import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { readSetting } from "../db.js";
import type { Dish } from "../dishes/repo.js";
import { CliAgent, NoAgent, ScriptedLlmAgent, type SelectDishesInput } from "../llm/index.js";
import { planWeek } from "../planner/plan-week.js";
import { quickDayLimitFor, readPlannerSettings } from "../planner/settings.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function start() {
  const app = withEnglish(await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-settings-http-")) }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe("Settings page", () => {
  it("is listed on More, before Logs", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/more" });

    expect(res.body).toMatch(/<a class="row-link" href="\/settings"><span class="row-label">Settings<\/span>[\s\S]*href="\/logs"/);
  });

  it("shows the documented defaults in the form", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/settings" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="quick_day_tue" value="30"');
    expect(res.body).toContain('name="quick_day_mon" value=""');
    expect(res.body).toContain('name="schedule_time" value="18:00"');
    expect(res.body).toContain('name="variety_window_weeks" value="3"');
    expect(res.body).toContain('name="category_collision_enabled" checked');
    expect(res.body).toContain('name="default_prep_limit_minutes" value="30"');
    expect(res.body).toContain('name="agent_command" value="" placeholder="copilot --model gpt-5-mini --reasoning-effort low --allow-tool=url -p"');
    expect(res.body).toContain('name="webhook_url" value=""');
  });

  it("saves the form; the Quick Day template is what the planner reads (FR-6d)", async () => {
    const app = await start();

    const saved = await app.inject({
      method: "POST",
      url: "/settings",
      payload: {
        quick_day_mon: "",
        quick_day_tue: "20",
        quick_day_wed: "",
        quick_day_thu: "45",
        quick_day_fri: "",
        quick_day_sat: "",
        quick_day_sun: "",
        default_prep_limit_minutes: "40",
        cron_expression: "30 17 * * 6",
        variety_window_weeks: "5",
        // category_collision_enabled omitted: an unchecked checkbox is not posted
        agent_command: "",
        shopping_list_sinks: '[{"type":"trello"}]',
      },
    });
    const shown = await app.inject({ method: "GET", url: "/settings" });

    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toBe("/settings");
    expect(readPlannerSettings(app.ctx.db)).toMatchObject({
      quickDayTemplate: { tue: 20, thu: 45 },
      defaultPrepLimitMinutes: 40,
      varietyWindowWeeks: 5,
      categoryCollisionEnabled: false,
    });
    expect(readSetting(app.ctx.db, "cron_expression")).toBe("30 17 * * 6");
    expect(readSetting(app.ctx.db, "shopping_list_sinks")).toBe('[{"type":"trello"}]');
    expect(shown.body).toContain('name="quick_day_thu" value="45"');
    expect(shown.body).not.toContain('name="category_collision_enabled" checked');
  });

  it("rejects a malformed cron expression and bad sink JSON without saving", async () => {
    const app = await start();

    const badCron = await app.inject({
      method: "POST",
      url: "/settings",
      payload: { cron_expression: "every sunday", shopping_list_sinks: "[]", variety_window_weeks: "3", default_prep_limit_minutes: "30" },
    });
    const badJson = await app.inject({
      method: "POST",
      url: "/settings",
      payload: { cron_expression: "0 18 * * 0", shopping_list_sinks: "{not json", variety_window_weeks: "3", default_prep_limit_minutes: "30" },
    });

    expect(badCron.statusCode).toBe(400);
    expect(badCron.body).toContain("cron");
    expect(badJson.statusCode).toBe(400);
    expect(badJson.body).toContain("JSON array");
    expect(readSetting(app.ctx.db, "cron_expression")).toBeUndefined();
    expect(readSetting(app.ctx.db, "shopping_list_sinks")).toBeUndefined();
  });

  it("stores a valid IANA timezone, rejects an unknown one, and blank clears it", async () => {
    const app = await start();
    const base = { cron_expression: "0 18 * * 0", shopping_list_sinks: "[]", variety_window_weeks: "3", default_prep_limit_minutes: "30" };

    const bad = await app.inject({ method: "POST", url: "/settings", payload: { ...base, timezone: "Mars/Olympus" } });
    const good = await app.inject({ method: "POST", url: "/settings", payload: { ...base, timezone: "Europe/Stockholm" } });
    const shown = await app.inject({ method: "GET", url: "/settings" });
    const cleared = await app.inject({ method: "POST", url: "/settings", payload: { ...base, timezone: "" } });

    expect(bad.statusCode).toBe(400);
    expect(good.statusCode).toBe(303);
    expect(shown.body).toContain('name="timezone" value="Europe/Stockholm"');
    expect(cleared.statusCode).toBe(303);
    expect(readSetting(app.ctx.db, "timezone")).toBe("");
  });

  it("passes the saved timezone to the running scheduler", async () => {
    const calls: [string, string | undefined][] = [];
    const app = await buildApp({
      dataDir: mkdtempSync(join(tmpdir(), "mp-settings-http-")),
      scheduler: { reschedule: (cronExpression, timezone) => void calls.push([cronExpression, timezone]) },
    });
    apps.push(app);
    const base = { cron_expression: "0 18 * * 0", shopping_list_sinks: "[]", variety_window_weeks: "3", default_prep_limit_minutes: "30" };

    await app.inject({ method: "POST", url: "/settings", payload: { ...base, timezone: "Europe/Stockholm" } });
    await app.inject({ method: "POST", url: "/settings", payload: base });

    expect(calls).toEqual([["0 18 * * 0", "Europe/Stockholm"], ["0 18 * * 0", undefined]]);
  });

  it("re-arms the running scheduler with the saved cron expression (no restart)", async () => {
    const rescheduled: string[] = [];
    const app = await buildApp({
      dataDir: mkdtempSync(join(tmpdir(), "mp-settings-http-")),
      scheduler: { reschedule: (cronExpression) => void rescheduled.push(cronExpression) },
    });
    apps.push(app);

    const rejected = await app.inject({
      method: "POST",
      url: "/settings",
      payload: { cron_expression: "61 25 * * *", shopping_list_sinks: "[]", variety_window_weeks: "3", default_prep_limit_minutes: "30" },
    });
    const saved = await app.inject({
      method: "POST",
      url: "/settings",
      payload: { cron_expression: "15 7 * * 1", shopping_list_sinks: "[]", variety_window_weeks: "3", default_prep_limit_minutes: "30" },
    });

    expect(rejected.statusCode).toBe(400);
    expect(saved.statusCode).toBe(303);
    expect(rescheduled).toEqual(["15 7 * * 1"]);
  });
});

describe("agent_command", () => {
  const form = (agent_command: string) => ({
    method: "POST" as const,
    url: "/settings",
    payload: { agent_command, cron_expression: "0 18 * * 0", shopping_list_sinks: "[]", variety_window_weeks: "3", default_prep_limit_minutes: "30" },
  });

  it("takes effect on the next run without a restart (ADR-0005, FR-16)", async () => {
    vi.stubEnv("AGENT_COMMAND", "");
    const app = await start();
    expect(app.ctx.llm).toBeInstanceOf(NoAgent);

    await app.inject(form("myagent --json"));
    const first = app.ctx.llm;
    await app.inject(form("otheragent -p"));
    const second = app.ctx.llm;
    await app.inject(form(""));

    expect(first).toBeInstanceOf(CliAgent);
    expect((first as CliAgent).command).toBe("myagent --json");
    expect((second as CliAgent).command).toBe("otheragent -p");
    expect(app.ctx.llm).toBeInstanceOf(NoAgent);
  });

  it("falls back to AGENT_COMMAND (the server default) when the saved command is blank", async () => {
    vi.stubEnv("AGENT_COMMAND", "copilot -p");
    const app = await start();

    await app.inject(form(""));

    expect((app.ctx.llm as CliAgent).command).toBe("copilot -p");
  });

  it("keeps the same agent instance while the command is unchanged", async () => {
    const app = await start();
    await app.inject(form("myagent --json"));

    expect(app.ctx.llm).toBe(app.ctx.llm);
  });

  it("never replaces an injected agent (tests keep their ScriptedLlmAgent)", async () => {
    const llm = new ScriptedLlmAgent({});
    const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-settings-http-")), llm });
    apps.push(app);

    await app.inject(form("myagent --json"));

    expect(app.ctx.llm).toBe(llm);
  });
});

describe("Per-week Quick Day overrides", () => {
  const WEEK = "2026-10-12"; // Monday
  const OTHER_WEEK = "2026-10-19";

  it("shows the template as the starting point for a week with no override", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: `/settings/quick-days?week=${WEEK}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`name="week" value="${WEEK}"`);
    expect(res.body).toContain('name="quick_day_tue" value="30"');
    expect(res.body).toContain('name="quick_day_mon" value=""');
  });

  it("rejects a week that is not a Monday", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/settings/quick-days?week=2026-10-13" });

    expect(res.statusCode).toBe(400);
  });

  it("stores an override that applies to that week only; the template still applies elsewhere", async () => {
    const app = await start();

    const saved = await app.inject({
      method: "POST",
      url: "/settings/quick-days",
      payload: { week: WEEK, quick_day_mon: "", quick_day_tue: "", quick_day_wed: "15", quick_day_thu: "", quick_day_fri: "", quick_day_sat: "", quick_day_sun: "" },
    });
    const shown = await app.inject({ method: "GET", url: `/settings/quick-days?week=${WEEK}` });

    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toBe(`/settings/quick-days?week=${WEEK}`);
    expect(shown.body).toContain('name="quick_day_wed" value="15"');
    expect(shown.body).toContain('name="quick_day_tue" value=""');
    const settings = readPlannerSettings(app.ctx.db);
    expect(settings.quickDayOverrides).toEqual({ [WEEK]: { mon: null, tue: null, wed: 15, thu: null, fri: null, sat: null, sun: null } });
    expect(quickDayLimitFor(settings, WEEK, "tue")).toBeNull();
    expect(quickDayLimitFor(settings, WEEK, "wed")).toBe(15);
    expect(quickDayLimitFor(settings, OTHER_WEEK, "tue")).toBe(30);
    expect(quickDayLimitFor(settings, OTHER_WEEK, "wed")).toBeNull();
  });

  it("is honoured by the planner for that week only", async () => {
    const app = await start();
    await app.inject({
      method: "POST",
      url: "/settings/quick-days",
      payload: { week: WEEK, quick_day_tue: "", quick_day_wed: "15" },
    });
    const quick: Dish = {
      id: 1, name: "Omelette", recipeUrl: null, adaptationNotes: null, prepTimeMinutes: 10,
      mainCategory: null, inRotation: true, preferredDays: [], weekendOnly: false, ingredients: [],
    };
    const slow: Dish = { ...quick, id: 2, name: "Stew", prepTimeMinutes: 60 };
    const planFor = async (weekStart: string) => {
      const llm = new ScriptedLlmAgent({ selectDishes: { ok: true, value: [] } });
      await planWeek({
        weekStart,
        dishes: [quick, slow],
        lunchByDate: {},
        settings: readPlannerSettings(app.ctx.db),
        recentlyPlanned: [],
        llm,
      });
      return llm.calls[0]?.args[0] as SelectDishesInput;
    };

    const overridden = await planFor(WEEK);
    const other = await planFor(OTHER_WEEK);

    expect(overridden.days.map((d) => d.isQuickDay)).toEqual([false, false, true, false, false, false, false]);
    expect(overridden.candidates[2]?.map((d) => d.name)).toEqual(["Omelette"]);
    expect(other.days.map((d) => d.isQuickDay)).toEqual([false, true, false, false, false, false, false]);
    expect(other.candidates[1]?.map((d) => d.name)).toEqual(["Omelette"]);
  });
});

describe("suggestion style", () => {
  it("shows the default, saves the entered text and shows it again", async () => {
    const app = await start();
    const first = await app.inject({ method: "GET", url: "/settings" });
    expect(first.body).toContain('name="suggestion_style" value="family-friendly Swedish home cooking for a household with kids"');
    expect(first.body).toContain("Suggestion style");

    await app.inject({
      method: "POST",
      url: "/settings",
      payload: { suggestion_style: "vegetarian Indian", cron_expression: "0 18 * * 0", shopping_list_sinks: "[]", variety_window_weeks: "3", default_prep_limit_minutes: "30" },
    });

    expect(readSetting(app.ctx.db, "suggestion_style")).toBe("vegetarian Indian");
    const again = await app.inject({ method: "GET", url: "/settings" });
    expect(again.body).toContain('name="suggestion_style" value="vegetarian Indian"');
  });
});

describe("Settings sections (grouped, plain controls)", () => {
  const base = { variety_window_weeks: "3", default_prep_limit_minutes: "30" };
  const sections = (body: string) => [...body.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);

  it("groups the page into its sections and links to Logs (English)", async () => {
    const app = await start();
    const res = await app.inject({ method: "GET", url: "/settings" });
    expect(sections(res.body)).toEqual(["Week & Quick Days", "Planning", "Agent", "Recipients", "Language"]);
    expect(res.body).toContain('href="/logs"');
  });

  it("groups the page into its sections (Swedish)", async () => {
    const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-settings-sv-")) });
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/settings" });
    expect(sections(res.body)).toEqual(["Vecka & snabbdagar", "Planering", "Agent", "Mottagare", "Språk"]);
    expect(res.body).toContain("Söndag");
  });

  it("shows the default schedule as weekday and time with no advanced field", async () => {
    const app = await start();
    const res = await app.inject({ method: "GET", url: "/settings" });
    expect(res.body).toMatch(/<option value="0" selected>Sunday<\/option>/);
    expect(res.body).toContain('name="schedule_time" value="18:00"');
    expect(res.body).not.toContain('name="cron_expression"');
  });

  it("round-trips the picker to cron: Sunday 18:00 <-> 0 18 * * 0", async () => {
    const app = await start();
    const saved = await app.inject({ method: "POST", url: "/settings", payload: { ...base, schedule_day: "5", schedule_time: "07:30" } });
    expect(saved.statusCode).toBe(303);
    expect(readSetting(app.ctx.db, "cron_expression")).toBe("30 7 * * 5");
    const shown = await app.inject({ method: "GET", url: "/settings" });
    expect(shown.body).toMatch(/<option value="5" selected>Friday<\/option>/);
    expect(shown.body).toContain('name="schedule_time" value="07:30"');
    await app.inject({ method: "POST", url: "/settings", payload: { ...base, schedule_day: "0", schedule_time: "18:00" } });
    expect(readSetting(app.ctx.db, "cron_expression")).toBe("0 18 * * 0");
  });

  it("rejects a malformed picker time", async () => {
    const app = await start();
    const res = await app.inject({ method: "POST", url: "/settings", payload: { ...base, schedule_day: "0", schedule_time: "25:99" } });
    expect(res.statusCode).toBe(400);
    expect(readSetting(app.ctx.db, "cron_expression")).toBeUndefined();
  });

  it("shows and saves an unusual cron under avancerat", async () => {
    const app = await start();
    const saved = await app.inject({ method: "POST", url: "/settings", payload: { ...base, cron_expression: "*/15 * * * 1-5" } });
    expect(saved.statusCode).toBe(303);
    expect(readSetting(app.ctx.db, "cron_expression")).toBe("*/15 * * * 1-5");
    const shown = await app.inject({ method: "GET", url: "/settings" });
    expect(shown.body).toMatch(/<details[^>]* open>\s*<summary>Advanced<\/summary>/);
    expect(shown.body).toContain('name="cron_expression" value="*/15 * * * 1-5"');
    // Saving the page again unchanged keeps it.
    await app.inject({ method: "POST", url: "/settings", payload: { ...base, cron_expression: "*/15 * * * 1-5", schedule_day: "", schedule_time: "" } });
    expect(readSetting(app.ctx.db, "cron_expression")).toBe("*/15 * * * 1-5");
  });

  it("writes the webhook URL and format to the sinks JSON and shows them again", async () => {
    const app = await start();
    await app.inject({ method: "POST", url: "/settings", payload: { ...base, schedule_day: "0", schedule_time: "18:00", webhook_url: "https://ntfy.sh/mat", webhook_format: "json" } });
    expect(JSON.parse(readSetting(app.ctx.db, "shopping_list_sinks")!)).toEqual([{ type: "webhook", url: "https://ntfy.sh/mat", format: "json" }]);
    const shown = await app.inject({ method: "GET", url: "/settings" });
    expect(shown.body).toContain('name="webhook_url" value="https://ntfy.sh/mat"');
    expect(shown.body).toMatch(/<option value="json" selected>/);
    await app.inject({ method: "POST", url: "/settings", payload: { ...base, schedule_day: "0", schedule_time: "18:00", webhook_url: "", webhook_format: "ntfy" } });
    expect(JSON.parse(readSetting(app.ctx.db, "shopping_list_sinks")!)).toEqual([]);
  });

  it("keeps other sink entries when the webhook changes, and rejects a non-http URL", async () => {
    const app = await start();
    await app.inject({ method: "POST", url: "/settings", payload: { ...base, schedule_day: "0", schedule_time: "18:00", shopping_list_sinks: '[{"type":"trello"}]' } });
    await app.inject({ method: "POST", url: "/settings", payload: { ...base, schedule_day: "0", schedule_time: "18:00", webhook_url: "https://ntfy.sh/mat", webhook_format: "ntfy" } });
    expect(JSON.parse(readSetting(app.ctx.db, "shopping_list_sinks")!)).toEqual([{ type: "trello" }, { type: "webhook", url: "https://ntfy.sh/mat", format: "ntfy" }]);
    const bad = await app.inject({ method: "POST", url: "/settings", payload: { ...base, schedule_day: "0", schedule_time: "18:00", webhook_url: "ftp://x" } });
    expect(bad.statusCode).toBe(400);
  });

  it("shows whether Trello is configured from env", async () => {
    const without = withEnglish(await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-settings-trello-")), env: {} }));
    apps.push(without);
    expect((await without.inject({ method: "GET", url: "/settings" })).body).toContain("Trello: not configured");
    const withEnv = withEnglish(await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-settings-trello-")), env: { TRELLO_KEY: "k", TRELLO_TOKEN: "t", TRELLO_BOARD_ID: "b" } }));
    apps.push(withEnv);
    const body = (await withEnv.inject({ method: "GET", url: "/settings" })).body;
    expect(body).toContain("Trello: configured");
    expect(body).not.toContain(">t<");
  });

  it("shows the agent command and whether its binary was found", async () => {
    vi.stubEnv("AGENT_COMMAND", "");
    const app = await start();
    expect((await app.inject({ method: "GET", url: "/settings" })).body).toContain("No agent");
    await app.inject({ method: "POST", url: "/settings", payload: { ...base, schedule_day: "0", schedule_time: "18:00", agent_command: "no-such-binary-xyz -p" } });
    expect((await app.inject({ method: "GET", url: "/settings" })).body).toContain("Agent program not found");
    await app.inject({ method: "POST", url: "/settings", payload: { ...base, schedule_day: "0", schedule_time: "18:00", agent_command: "node -p" } });
    expect((await app.inject({ method: "GET", url: "/settings" })).body).toContain("Agent found");
  });
});
