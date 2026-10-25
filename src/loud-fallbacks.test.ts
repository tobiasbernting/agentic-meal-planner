import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "./app.js";
import { createDish } from "./dishes/repo.js";
import { ScriptedLlmAgent } from "./llm/index.js";
import { createCapturingLogger, type LogRecord } from "./logging/logger.js";
import { savePlan } from "./planner/repo.js";
import { createSchool } from "./schools/repo.js";
import { weekDates } from "./week.js";
import { planRunSettled, postPlanRun } from "./plan-run/test-helpers.js";

// Wednesday 2026-10-21; the week starts Monday 2026-10-19.
const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";
const PLUGIN_URL = "https://north.example/menu.lunch.json";
const LLM_URL = "https://south.example/lunch";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function start(options: Partial<AppOptions> = {}) {
  const { logger, records } = createCapturingLogger();
  const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-loud-")), now: () => NOW, logger, ...options });
  apps.push(app);
  return { app, records };
}

/** The records of the one request to `url`, found by the runId on its "request completed" line. */
function runRecords(records: LogRecord[], url: string): LogRecord[] {
  const runId = records.find((r) => r.msg === "request completed" && r.url === url)?.runId;
  expect(runId).toEqual(expect.any(String));
  return records.filter((r) => r.runId === runId);
}

const form = { weekStart: WEEK };

describe("loud fallbacks on POST /plan/generate", () => {
  it("warns with the degradedReasons when the agent's selection fails", async () => {
    const { app, records } = await start({
      llm: new ScriptedLlmAgent({ selectDishes: { ok: false, reason: "agent exited with code 1" } }),
    });
    createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });

    await postPlanRun(app, "/plan/generate", form);

    expect(runRecords(records, "/plan/generate")).toContainEqual(
      expect.objectContaining({ level: "warn", component: "planner", degradedReasons: expect.arrayContaining(["agent exited with code 1"]) }),
    );
  });

  it("logs info when no plugin claims the URL, and warns with the reason when extraction fails", async () => {
    const { app, records } = await start({
      fetchPage: async () => "<html/>",
      llm: new ScriptedLlmAgent({ extractLunchMenu: { ok: false, reason: "invalid JSON after retry" } }),
    });
    const school = createSchool(app.ctx.db, { name: "South", url: LLM_URL });

    await postPlanRun(app, "/plan/generate", form);

    const run = runRecords(records, "/plan/generate");
    expect(run).toContainEqual(expect.objectContaining({ level: "info", component: "lunch-ingest", msg: "using LLM fallback", schoolId: school.id }));
    expect(run).toContainEqual(
      expect.objectContaining({ level: "warn", component: "lunch-ingest", schoolId: school.id, reason: "invalid JSON after retry" }),
    );
    expect(run).toContainEqual(expect.objectContaining({ level: "info", msg: "ingest summary", schoolId: school.id, status: "no-data", entries: 0 }));
  });

  it("warns with the HTTP status when the fetch fails", async () => {
    const { app, records } = await start({
      fetchPage: async (url) => {
        throw new Error(`HTTP 503 fetching ${url}`);
      },
      llm: new ScriptedLlmAgent(),
    });
    createSchool(app.ctx.db, { name: "South", url: LLM_URL });

    await postPlanRun(app, "/plan/generate", form);

    expect(runRecords(records, "/plan/generate")).toContainEqual(
      expect.objectContaining({ level: "warn", component: "lunch-ingest", msg: "menu fetch failed", reason: `HTTP 503 fetching ${LLM_URL}` }),
    );
  });

  it("warns when a School Plugin throws", async () => {
    const { app, records } = await start({
      fetchPage: async () => {
        throw new Error("offline");
      },
    });
    createSchool(app.ctx.db, { name: "North", url: PLUGIN_URL });

    await postPlanRun(app, "/plan/generate", form);

    expect(runRecords(records, "/plan/generate")).toContainEqual(
      expect.objectContaining({ level: "warn", component: "lunch-ingest", msg: "school plugin failed", pluginId: "example-json", reason: "offline" }),
    );
  });

  it("warns (component school-plugin) on malformed data and logs an ingest summary with the entry count", async () => {
    const { app, records } = await start({ fetchPage: async () => "<html>not json</html>" });
    createSchool(app.ctx.db, { name: "North", url: PLUGIN_URL });

    await postPlanRun(app, "/plan/generate", form);

    const run = runRecords(records, "/plan/generate");
    expect(run).toContainEqual(expect.objectContaining({ level: "warn", component: "school-plugin", pluginId: "example-json" }));
    expect(run).toContainEqual(expect.objectContaining({ level: "info", msg: "ingest summary", status: "no-data", entries: 0 }));
  });

  it("logs a plan summary with dinners, degraded and sinksPushed", async () => {
    const { app, records } = await start({ llm: new ScriptedLlmAgent({ selectDishes: { ok: false, reason: "boom" } }) });
    createDish(app.ctx.db, { name: "Burgers", prepTimeMinutes: 20 });

    await postPlanRun(app, "/plan/generate", form);

    expect(runRecords(records, "/plan/generate")).toContainEqual(
      expect.objectContaining({ level: "info", component: "plan", msg: "plan summary", dinners: 7, degraded: true, sinksPushed: 0 }),
    );
  });
});

describe("loud fallbacks on the Shopping List", () => {
  it("warns when ingredient resolution is degraded, with the run's id", async () => {
    const { app, records } = await start({ llm: new ScriptedLlmAgent({ findRecipe: { ok: false, reason: "no recipe found" } }) });
    const dish = createDish(app.ctx.db, { name: "Mystery stew" });
    savePlan(
      app.ctx.db,
      {
        weekStart: WEEK,
        dinners: weekDates(WEEK).map((date, i) => ({ date, dishId: i === 0 ? dish : null, isQuickDay: false, lunchThatDay: null, rationale: "r" })),
        degradedReasons: [],
      },
      NOW.toISOString(),
    );

    await app.inject({ method: "POST", url: "/plan/regenerate", payload: form });
    await planRunSettled(app, WEEK);

    expect(runRecords(records, "/plan/regenerate")).toContainEqual(
      expect.objectContaining({ level: "warn", component: "ingredients", dish: "Mystery stew", reason: "no recipe found" }),
    );
  });
});
