import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDish } from "../dishes/repo.js";
import { createPantryItem } from "../pantry/repo.js";
import { createSchool } from "../schools/repo.js";
import { recordIngestOutcome } from "../lunch/outcome.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function makeApp() {
  const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-shell-")), now: () => new Date(2026, 9, 21, 18, 30), logLevel: "info", logDestination: { write: () => true } });
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

/** The tab bar's links as [href, label, active], in document order. */
function tabs(html: string): [string, string, boolean][] {
  const nav = /<nav class="tabbar"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  return [...nav.matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)].map((m) => [m[1]!, m[3]!, Boolean(m[2])]);
}

const PAGES: [url: string, active: string][] = [
  ["/", "Idag"],
  ["/plan", "Plan"],
  ["/shopping", "Inköp"],
  ["/more", "Mer"],
  ["/dishes", "Mer"],
  ["/dishes/new", "Mer"],
  ["/schools", "Mer"],
  ["/pantry", "Mer"],
  ["/settings", "Mer"],
  ["/settings/quick-days?week=2026-10-19", "Mer"],
  ["/logs", "Mer"],
];

describe("the almanac shell", () => {
  it("renders the tab bar Idag, Plan, Inköp, Mer on every page, marking the active tab", async () => {
    const app = await makeApp();
    for (const [url, active] of PAGES) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(tabs(res.body), url).toEqual([
        ["/", "Idag", active === "Idag"],
        ["/plan", "Plan", active === "Plan"],
        ["/shopping", "Inköp", active === "Inköp"],
        ["/more", "Mer", active === "Mer"],
      ]);
    }
  });

  it("labels the tabs in English with the lang=en cookie", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/plan", headers: { cookie: "lang=en" } });
    expect(tabs(res.body).map(([, label]) => label)).toEqual(["Today", "Plan", "Shopping", "More"]);
  });
});

/** Every URL a page or stylesheet makes the browser load: src=, <link href=>, CSS url(). */
function loadedUrls(text: string): string[] {
  const src = [...text.matchAll(/\ssrc="([^"]*)"/g)].map((m) => m[1]!);
  const links = [...text.matchAll(/<link\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1]!);
  const css = [...text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]!);
  const imports = [...text.matchAll(/@import\s+["']([^"']+)["']/g)].map((m) => m[1]!);
  return [...src, ...links, ...css, ...imports];
}

describe("assets (NFR-2)", () => {
  it("serves HTMX, the stylesheet and the fonts from the app, and no page loads anything from another host", async () => {
    const app = await makeApp();
    createSchool(app.ctx.db, { name: "Skolan", url: "https://example.test/menu" });
    const loaded = new Set<string>();
    for (const [url] of PAGES) {
      const res = await app.inject({ method: "GET", url });
      for (const ref of loadedUrls(res.body)) {
        expect(ref, `${url} loads ${ref}`).toMatch(/^\/(?!\/)/);
        loaded.add(ref);
      }
    }
    expect([...loaded].some((u) => /htmx.*\.js$/.test(u))).toBe(true);

    const css = await app.inject({ method: "GET", url: "/assets/app.css" });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    const fonts = loadedUrls(css.body);
    expect(fonts.length).toBeGreaterThanOrEqual(4);
    for (const ref of [...loaded, ...fonts]) {
      expect(ref, `stylesheet loads ${ref}`).toMatch(/^\/(?!\/)/);
      const res = await app.inject({ method: "GET", url: ref });
      expect(res.statusCode, ref).toBe(200);
      expect(res.rawPayload.length, ref).toBeGreaterThan(0);
    }
    expect((await app.inject({ method: "GET", url: fonts[0]! })).headers["content-type"]).toBe("font/woff2");
  });

  it("answers 404 for an unknown asset", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/assets/nope.js" })).statusCode).toBe(404);
  });
});

describe("Mer", () => {
  function moreRows(html: string): [string, string, string][] {
    return [...html.matchAll(/<a class="row-link" href="([^"]+)"><span class="row-label">([^<]+)<\/span><span class="row-status">([^<]*)<\/span><\/a>/g)].map((m) => [m[1]!, m[2]!, m[3]!]);
  }

  it("lists Rätter, Skolor, Skafferi, Inställningar and Loggar with a count or status each", async () => {
    const app = await makeApp();
    for (const name of ["Köttbullar", "Pannkakor"]) createDish(app.ctx.db, { name, inRotation: name === "Köttbullar" });
    createDish(app.ctx.db, { name: "Tacos", inRotation: false });
    const school = createSchool(app.ctx.db, { name: "Lunnaskolan", url: "https://example.test/menu" });
    recordIngestOutcome(app.ctx.db, { schoolId: school.id, weekStart: "2026-10-19", status: "fetched", reason: null, recordedAt: new Date(2026, 9, 17, 10, 20).toISOString() });
    createPantryItem(app.ctx.db, { name: "Salt", aliases: [] });

    const res = await app.inject({ method: "GET", url: "/more" });

    expect(moreRows(res.body)).toEqual([
      ["/dishes", "Rätter", "3 rätter, 1 i rotation"],
      ["/schools", "Skolor", "1 skola, hämtad lör 10:20"],
      ["/pantry", "Skafferi", "1 vara"],
      ["/settings", "Inställningar", "Ingen agent, enklare planer"],
      ["/logs", "Loggar", "Nivå: info"],
    ]);
  });

  it("speaks English with the lang=en cookie and says when nothing is set up", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/more", headers: { cookie: "lang=en" } });
    expect(moreRows(res.body).map(([, label, status]) => [label, status])).toEqual([
      ["Dishes", "0 dishes, 0 in rotation"],
      ["Schools", "0 schools"],
      ["Pantry", "0 items"],
      ["Settings", "No agent, simpler plans"],
      ["Logs", "Level: info"],
    ]);
  });
});

describe("the inverted-ink notice", () => {
  it("renders form errors as an alert notice block (Settings, Schools, Pantry)", async () => {
    const app = await makeApp();
    const settings = await app.inject({ method: "POST", url: "/settings", payload: { cron_expression: "every sunday", shopping_list_sinks: "[]", variety_window_weeks: "3", default_prep_limit_minutes: "30" } });
    const schools = await app.inject({ method: "POST", url: "/schools", payload: { name: "", url: "" } });
    const pantry = await app.inject({ method: "POST", url: "/pantry", payload: { name: "" } });
    for (const res of [settings, schools, pantry]) {
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/<div class="notice" role="alert">[\s\S]*?<span class="notice-text">[^<]+<\/span><\/div>/);
    }
  });
});
