import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { ScriptedLlmAgent } from "../llm/fake.js";
import { createSchool } from "../schools/repo.js";
import { getIngestOutcome } from "./outcome.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// A Wednesday evening, local time; its week starts Monday 2026-10-19.
const NOW = new Date(2026, 9, 21, 18, 30);
const WEEK = "2026-10-19";

async function start(options: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-outcome-http-"));
  const app = withEnglish(await buildApp({ dataDir, now: () => NOW, ...options }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const failingFetch = async () => {
  throw new Error("connection refused");
};
const failingAgent = () => new ScriptedLlmAgent({ extractLunchMenu: { ok: false, reason: "agent exited with code 1" } });
const MENU = [{ date: "2026-10-21", rawText: "Pasta bolognese" }];

describe("Ingest Outcome recording", () => {
  it("stores no-data with the reason when the menu fetch fails", async () => {
    const app = await start({ fetchPage: failingFetch, llm: failingAgent() });
    const school = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });

    await app.inject({ method: "POST", url: "/lunch/refresh" });

    expect(getIngestOutcome(app.ctx.db, school.id)).toEqual({
      schoolId: school.id,
      weekStart: WEEK,
      status: "no-data",
      reason: "fetch failed: connection refused",
      recordedAt: NOW.toISOString(),
    });
  });

  it("stores no-data with the agent's reason when extraction fails", async () => {
    const app = await start({ fetchPage: async () => "<html/>", llm: failingAgent() });
    const school = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });

    await app.inject({ method: "POST", url: "/lunch/refresh" });

    expect(getIngestOutcome(app.ctx.db, school.id)).toMatchObject({ status: "no-data", reason: "agent exited with code 1" });
  });

  it("replaces a failure with fetched, then cached, on later attempts", async () => {
    let fail = true;
    const llm = new ScriptedLlmAgent({
      extractLunchMenu: () => (fail ? { ok: false, reason: "agent exited with code 1" } : { ok: true, value: MENU.concat(
        ["2026-10-19", "2026-10-20", "2026-10-22", "2026-10-23"].map((date) => ({ date, rawText: "Soppa" })),
      ) }),
    });
    const app = await start({ fetchPage: async () => "<html/>", llm });
    const school = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });

    await app.inject({ method: "POST", url: "/lunch/refresh" });
    fail = false;
    await app.inject({ method: "POST", url: "/lunch/refresh" });
    expect(getIngestOutcome(app.ctx.db, school.id)).toMatchObject({ status: "fetched", reason: null });

    await app.inject({ method: "POST", url: "/plan/generate", payload: { weekStart: WEEK } });
    expect(getIngestOutcome(app.ctx.db, school.id)).toMatchObject({ status: "cached", reason: null });
  });
});
