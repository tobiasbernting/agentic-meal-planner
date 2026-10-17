import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { withEnglish } from "../i18n/test-helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function start() {
  const app = withEnglish(await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-schools-http-")) }));
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
    expect(list.body).toContain("https://skolmaten.se/northside");
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
    expect(list.body).toContain("https://mashie.com/northside");
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
});
