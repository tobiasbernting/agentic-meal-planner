import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";
import { ScriptedLlmAgent } from "../llm/fake.js";
import { createSchool as insertSchool } from "./repo.js";
import { getIngestOutcome, recordIngestOutcome } from "../lunch/outcome.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

// A Saturday, 10:20 local time.
const NOW = new Date(2026, 9, 17, 10, 20);

async function start(options: Partial<AppOptions> = {}) {
  const app = withEnglish(await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-schools-http-")), now: () => NOW, ...options }));
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function createSchool(app: Awaited<ReturnType<typeof buildApp>>, name: string, url: string) {
  return app.inject({ method: "POST", url: "/schools", payload: { name, url } });
}

describe("Schools pages", () => {
  it("is listed on More", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/more" });

    expect(res.body).toContain('<a class="row-link" href="/schools"><span class="row-label">Schools</span>');
  });

  it("creates a School from the form and lists it", async () => {
    const app = await start();

    const created = await createSchool(app, "Northside", "https://skolmaten.se/northside");
    const list = await app.inject({ method: "GET", url: "/schools" });

    expect(created.statusCode).toBe(303);
    expect(created.headers.location).toBe("/schools");
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain("Northside");
    expect(list.body).toContain("skolmaten.se");
  });

  it("rejects a School without a menu URL", async () => {
    const app = await start();

    const res = await app.inject({ method: "POST", url: "/schools", payload: { name: "Nowhere", url: "" } });
    const list = await app.inject({ method: "GET", url: "/schools" });

    expect(res.statusCode).toBe(400);
    expect(list.body).not.toContain("Nowhere");
  });

  it("edits a School's name and menu URL", async () => {
    const app = await start();
    await createSchool(app, "Northside", "https://skolmaten.se/northside");

    const editPage = await app.inject({ method: "GET", url: "/schools/1/edit" });
    const updated = await app.inject({
      method: "POST",
      url: "/schools/1",
      payload: { name: "Northside Primary", url: "https://mashie.com/northside" },
    });
    const list = await app.inject({ method: "GET", url: "/schools" });

    expect(editPage.statusCode).toBe(200);
    expect(editPage.body).toContain('value="Northside"');
    expect(updated.statusCode).toBe(303);
    expect(list.body).toContain("Northside Primary");
    expect(list.body).toContain("mashie.com");
    expect(editPage.body).toContain('value="https://skolmaten.se/northside"');
    expect(list.body).not.toContain("skolmaten.se");
  });

  it("pauses and resumes a School, keeping it in the list", async () => {
    const app = await start();
    await createSchool(app, "Northside", "https://skolmaten.se/northside");

    const paused = await app.inject({ method: "POST", url: "/schools/1/pause" });
    const afterPause = await app.inject({ method: "GET", url: "/schools" });
    await app.inject({ method: "POST", url: "/schools/1/resume" });
    const afterResume = await app.inject({ method: "GET", url: "/schools" });

    expect(paused.statusCode).toBe(303);
    expect(afterPause.body).toContain("Northside");
    expect(afterPause.body).toContain("Paused");
    expect(afterResume.body).not.toContain("Paused");
  });

  it("deletes a School", async () => {
    const app = await start();
    await createSchool(app, "Northside", "https://skolmaten.se/northside");

    const deleted = await app.inject({ method: "POST", url: "/schools/1/delete" });
    const list = await app.inject({ method: "GET", url: "/schools" });

    expect(deleted.statusCode).toBe(303);
    expect(list.body).not.toContain("Northside");
  });

  it("returns 404 for an unknown School", async () => {
    const app = await start();

    const res = await app.inject({ method: "GET", url: "/schools/99/edit" });

    expect(res.statusCode).toBe(404);
  });

  it("shows the host name instead of the full menu URL", async () => {
    const app = await start();
    await createSchool(app, "Northside", "https://www.skolmaten.se/northside/menu?week=42");

    const list = await app.inject({ method: "GET", url: "/schools" });

    expect(list.body).toContain("www.skolmaten.se");
    expect(list.body).not.toContain("/northside/menu");
  });

  it("shows the fetch time in household terms, in English and Swedish", async () => {
    const app = await start();
    const school = insertSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    recordIngestOutcome(app.ctx.db, { schoolId: school.id, weekStart: "2026-10-12", status: "fetched", reason: null, recordedAt: NOW.toISOString() });

    const en = await app.inject({ method: "GET", url: "/schools" });
    const sv = await app.inject({ method: "GET", url: "/schools", headers: { cookie: "lang=sv" } });

    expect(en.body).toContain("fetched sat 10:20");
    expect(sv.body).toContain("hämtad lör 10:20");
    expect(en.body).not.toContain("<time");
    expect(en.body).not.toContain("/schools/1/retry");
  });

  it("shows a plain failure line and a retry action when the last attempt found no data", async () => {
    const app = await start();
    const school = insertSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    recordIngestOutcome(app.ctx.db, { schoolId: school.id, weekStart: "2026-10-12", status: "no-data", reason: "fetch failed: ECONNREFUSED", recordedAt: NOW.toISOString() });

    const en = await app.inject({ method: "GET", url: "/schools" });
    const sv = await app.inject({ method: "GET", url: "/schools", headers: { cookie: "lang=sv" } });

    expect(en.body).toContain("Could not fetch the menu");
    expect(en.body).toContain('action="/schools/1/retry"');
    expect(en.body).toContain("Try again");
    expect(en.body).not.toContain("ECONNREFUSED");
    expect(sv.body).toContain("Kunde inte hämta menyn");
    expect(sv.body).toContain("Försök igen");
  });

  it("retrying re-ingests only that School and redirects back", async () => {
    const pages: string[] = [];
    const app = await start({
      fetchPage: async (url) => {
        pages.push(url);
        return "<html/>";
      },
      llm: new ScriptedLlmAgent({ extractLunchMenu: { ok: true, value: [{ date: "2026-10-14", rawText: "Pasta" }] } }),
    });
    const north = insertSchool(app.ctx.db, { name: "Northside", url: "https://north.example/menu" });
    insertSchool(app.ctx.db, { name: "Southside", url: "https://south.example/menu" });
    recordIngestOutcome(app.ctx.db, { schoolId: north.id, weekStart: "2026-10-12", status: "no-data", reason: "boom", recordedAt: "2026-10-16T08:00:00.000Z" });

    const res = await app.inject({ method: "POST", url: `/schools/${north.id}/retry` });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/schools");
    expect(pages).toEqual(["https://north.example/menu"]);
    expect(getIngestOutcome(app.ctx.db, north.id)).toMatchObject({ status: "fetched", recordedAt: NOW.toISOString() });
    expect(getIngestOutcome(app.ctx.db, 2)).toBeNull();
  });

  it("retry on an unknown School is 404", async () => {
    const app = await start();

    const res = await app.inject({ method: "POST", url: "/schools/99/retry" });

    expect(res.statusCode).toBe(404);
  });
});
