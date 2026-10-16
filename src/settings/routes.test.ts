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
  it("links to Settings last in the nav", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.body).toMatch(/<a href="\/settings">Settings<\/a><\/nav>/);
  });

  it("shows the documented defaults in the form", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/settings" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="quick_day_tue" value="30"');
    expect(res.body).toContain('name="quick_day_mon" value=""');
    expect(res.body).toContain('name="cron_expression" value="0 18 * * 0"');
    expect(res.body).toContain('name="variety_window_weeks" value="3"');
    expect(res.body).toContain('name="category_collision_enabled" checked');
    expect(res.body).toContain('name="default_prep_limit_minutes" value="30"');
    expect(res.body).toContain('name="agent_command" value=""');
    expect(res.body).toContain('name="shopping_list_sinks">[]</textarea>');
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
