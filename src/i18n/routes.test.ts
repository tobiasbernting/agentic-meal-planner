import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createSchool } from "../schools/repo.js";
import { createPantryItem } from "../pantry/repo.js";
import { en } from "./en.js";
import { sv } from "./sv.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
async function makeApp() {
  const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-lang-")), now: () => new Date(2026, 9, 28, 12) });
  apps.push(app);
  return app;
}
afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

const form = { "content-type": "application/x-www-form-urlencoded" };

describe("POST /lang (FR-18)", () => {
  it("sets a persistent lang cookie and redirects to next", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: "/lang", headers: form, payload: "lang=en&next=%2Fdishes%3Fx%3D1" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/dishes?x=1");
    expect(res.headers["set-cookie"]).toBe("lang=en; Path=/; Max-Age=31536000; SameSite=Lax");
  });

  it.each(["https://evil.test/", "//evil.test", "dishes", "/\\evil.test"])("rejects unsafe next %s", async (next) => {
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: "/lang", headers: form, payload: `lang=sv&next=${encodeURIComponent(next)}` });
    expect(res.headers.location).toBe("/");
  });

  it("falls back to the same-origin Referer path when next is absent", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/lang",
      headers: { ...form, referer: "http://localhost:8039/pantry?a=b", host: "localhost:8039" },
      payload: "lang=en",
    });
    expect(res.headers.location).toBe("/pantry?a=b");
  });

  it("rejects an unknown language without setting a cookie", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: "/lang", headers: form, payload: "lang=de" });
    expect(res.statusCode).toBe(400);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("switches language without losing data, and the cookie persists", async () => {
    const app = await makeApp();
    createSchool(app.ctx.db, { name: "Skolan Norr", url: "https://example.test/m" });
    createPantryItem(app.ctx.db, { name: "Salt", aliases: [] });
    const sw = await app.inject({ method: "POST", url: "/lang", headers: form, payload: "lang=en&next=%2Fschools" });
    const cookie = String(sw.headers["set-cookie"]).split(";")[0]!;
    const res = await app.inject({ method: "GET", url: "/schools", headers: { cookie } });
    expect(res.body).toContain('<html lang="en">');
    expect(res.body).toContain("Skolan Norr");
    expect((await app.inject({ method: "GET", url: "/pantry", headers: { cookie } })).body).toContain("Salt");
  });
});

describe("language switch on Settings → Språk", () => {
  it("offers Svenska and English posting to /lang, returning to Settings", async () => {
    const app = await makeApp();
    const body = (await app.inject({ method: "GET", url: "/settings" })).body;
    const section = /<section id="language">([\s\S]*?)<\/section>/.exec(body)?.[1] ?? "";
    expect(section).toContain("<h2>Språk</h2>");
    expect(section).toContain('action="/lang"');
    expect(section).toContain('name="next" value="/settings"');
    expect(section).toMatch(/<button[^>]*value="sv"[^>]*>Svenska<\/button>/);
    expect(section).toMatch(/<button[^>]*value="en"[^>]*>English<\/button>/);
  });

  it("is not in the header of other pages", async () => {
    const app = await makeApp();
    for (const url of ["/", "/plan", "/shopping", "/dishes", "/more"]) {
      expect((await app.inject({ method: "GET", url })).body, url).not.toContain('action="/lang"');
    }
  });
});

describe("dictionaries", () => {
  it("have the same keys in en and sv", () => {
    expect(Object.keys(sv).sort()).toEqual(Object.keys(en).sort());
  });
});

describe("every screen renders in English with the lang=en cookie", () => {
  it("has English text and no Swedish chrome on each route", async () => {
    const app = await makeApp();
    const school = createSchool(app.ctx.db, { name: "Skolan", url: "https://example.test/menu" });
    const item = createPantryItem(app.ctx.db, { name: "Salt", aliases: [] });
    const screens: [string, string][] = [
      ["/", "Refresh lunch menus"],
      ["/plan", "No plan for this week"],
      ["/shopping", "Shopping List"],
      ["/dishes", "Dishes"],
      ["/dishes/new", "Main Category"],
      ["/schools", "Schools"],
      [`/schools/${typeof school === "number" ? school : school.id}/edit`, "Edit"],
      ["/pantry", "Pantry"],
      [`/pantry/${typeof item === "number" ? item : item.id}/edit`, "Edit"],
      ["/settings", "Settings"],
      ["/settings/quick-days?week=2026-10-26", "Quick"],
    ];
    for (const [url, text] of screens) {
      const res = await app.inject({ method: "GET", url, headers: { cookie: "lang=en" } });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain('<html lang="en">');
      expect(res.body, url).toContain(text);
      expect(res.body, url).not.toContain("Måltidsplaneraren");
    }
  });
});
