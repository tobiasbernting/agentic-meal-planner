import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { upsertLunchEntry } from "../lunch/repo.js";
import { createSchool, setSchoolActive } from "../schools/repo.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// A Wednesday evening, local time.
const NOW = new Date(2026, 9, 21, 18, 30);
const TODAY = "2026-10-21";

async function start(options: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mp-today-"));
  const app = await buildApp({ dataDir, now: () => NOW, ...options });
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe("GET / (Today view)", () => {
  it("shows today's date and each active School's Lunch Entry, one dish per line", async () => {
    const app = await start();
    const north = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    upsertLunchEntry(app.ctx.db, {
      schoolId: north.id,
      date: TODAY,
      rawText: "Pasta bolognese\nFiskgratäng",
      fetchedAt: NOW.toISOString(),
    });

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(TODAY);
    expect(res.body).toContain("Northside");
    expect(res.body).toMatch(/<li>Pasta bolognese<\/li>\s*<li>Fiskgratäng<\/li>/);
    expect(res.body).not.toContain("No lunch data");
  });

  it("shows the no-lunch-data notice for a School without an entry today (FR-5)", async () => {
    const app = await start();
    const north = createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    createSchool(app.ctx.db, { name: "Southside", url: "https://south.example/menu" });
    upsertLunchEntry(app.ctx.db, { schoolId: north.id, date: "2026-10-20", rawText: "Yesterday's soup", fetchedAt: NOW.toISOString() });

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.body).toContain("Northside");
    expect(res.body).toContain("Southside");
    expect(res.body).not.toContain("Yesterday's soup");
    expect(res.body.match(/No lunch data/g)).toHaveLength(2);
  });

  it("omits paused Schools", async () => {
    const app = await start();
    const paused = createSchool(app.ctx.db, { name: "Paused School", url: "https://paused.example/menu" });
    setSchoolActive(app.ctx.db, paused.id, false);

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.body).not.toContain("Paused School");
  });

  it("has a dinner placeholder section for the Planned Dinner", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.body).toMatch(/<section id="dinner">[\s\S]*No plan yet/);
  });
});

describe("POST /lunch/refresh", () => {
  it("ingests the current week through the injected fetchPage and redirects to the Today view", async () => {
    const url = "https://north.example/menu.lunch.json";
    const fetched: string[] = [];
    const app = await start({
      fetchPage: async (u) => {
        fetched.push(u);
        return JSON.stringify({ days: [{ date: TODAY, dishes: ["Pannkakor", "Ärtsoppa"] }] });
      },
    });
    createSchool(app.ctx.db, { name: "Northside", url });

    const res = await app.inject({ method: "POST", url: "/lunch/refresh" });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/");
    expect(fetched).toEqual([url]);
    const today = await app.inject({ method: "GET", url: "/" });
    expect(today.body).toMatch(/<li>Pannkakor<\/li>\s*<li>Ärtsoppa<\/li>/);
  });

  it("still redirects when a School's fetch fails", async () => {
    const app = await start({
      fetchPage: async () => {
        throw new Error("offline");
      },
    });
    createSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu.lunch.json" });

    const res = await app.inject({ method: "POST", url: "/lunch/refresh" });

    expect(res.statusCode).toBe(303);
    expect((await app.inject({ method: "GET", url: "/" })).body).toContain("No lunch data");
  });

});
