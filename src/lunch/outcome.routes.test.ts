import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { ScriptedLlmAgent } from "../llm/fake.js";
import { createSchool } from "../schools/repo.js";
import { getIngestOutcome, recordIngestOutcome } from "./outcome.js";
import { postPlanRun } from "../plan-run/test-helpers.js";

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

    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });
    expect(getIngestOutcome(app.ctx.db, school.id)).toMatchObject({ status: "cached", reason: null });
  });
});

describe("Schools page", () => {
  it("shows each School's latest Ingest Outcome with reason and time", async () => {
    const app = await start({ fetchPage: failingFetch, llm: failingAgent() });
    createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    createSchool(app.ctx.db, { name: "Southside", url: "https://south.example/menu" });

    const before = await app.inject({ method: "GET", url: "/schools" });
    expect(before.body).toContain("No ingest attempt yet");

    await app.inject({ method: "POST", url: "/lunch/refresh" });
    const res = await app.inject({ method: "GET", url: "/schools" });

    expect(res.body).toContain("No menu data");
    expect(res.body).toContain("fetch failed: connection refused");
    expect(res.body).toContain(`<time datetime="${NOW.toISOString()}">`);
    expect(res.body).not.toContain("No ingest attempt yet");
  });

  it("labels fetched and cached outcomes in Swedish", async () => {
    const app = await start();
    const school = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    recordIngestOutcome(app.ctx.db, { schoolId: school.id, weekStart: WEEK, status: "fetched", reason: null, recordedAt: NOW.toISOString() });

    const res = await app.inject({ method: "GET", url: "/schools", headers: { cookie: "lang=sv" } });

    expect(res.body).toContain("Hämtad");
  });
});

describe("no lunch data notice", () => {
  it("Today names each School without lunch and why", async () => {
    const app = await start({ fetchPage: failingFetch, llm: failingAgent() });
    createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    await app.inject({ method: "POST", url: "/lunch/refresh" });

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.body).toContain("Northside: fetch failed: connection refused");
  });

  it("Today keeps the generic message when no ingest was attempted", async () => {
    const app = await start();
    createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.body).toContain("No lunch data");
    expect(res.body).not.toContain("Northside:");
  });

  it("Plan names each School without lunch and why, after generate", async () => {
    const app = await start({ fetchPage: failingFetch, llm: failingAgent() });
    createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    await postPlanRun(app, "/plan/generate", { weekStart: WEEK });

    const res = await app.inject({ method: "GET", url: `/plan?week=${WEEK}` });

    expect(res.body).toContain("Northside: fetch failed: connection refused");
  });

  it("clears the reason once a later ingest succeeds", async () => {
    let fail = true;
    const llm = new ScriptedLlmAgent({
      extractLunchMenu: () => (fail ? { ok: false, reason: "agent exited with code 1" } : { ok: true, value: MENU }),
    });
    const app = await start({ fetchPage: async () => "<html/>", llm });
    createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    await app.inject({ method: "POST", url: "/lunch/refresh" });
    fail = false;
    await app.inject({ method: "POST", url: "/lunch/refresh" });

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.body).not.toContain("agent exited with code 1");
  });
});
