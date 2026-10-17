import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backPath, cacheKeysFor, classify, extractLang, injectBanner, offlineResponseFor, prewarmUrls } from "../../public/offline/core.js";
import { buildApp } from "../app.js";
import { workerConfig } from "./routes.js";

const config = workerConfig();
const ORIGIN = "http://meals.lan:8080";
const MARKER = '<div id="offline-banner"></div>';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

/** A real page as the server renders it, in the household's language. */
async function renderedPage(url: string, lang: "sv" | "en" = "sv"): Promise<string> {
  const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-offline-core-")), now: () => new Date(2026, 9, 17, 7, 45), logLevel: "info", logDestination: { write: () => true } });
  apps.push(app);
  return (await app.inject({ method: "GET", url, headers: { cookie: `lang=${lang}` } })).body;
}

/** A route pattern with every `:param` filled in, as a browser would request it. */
function concrete(pattern: string): string {
  return pattern.replace(/:[a-z]+/g, "7");
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(ORIGIN + path, { headers });
}

function post(path: string, headers: Record<string, string> = {}): Request {
  return new Request(ORIGIN + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: "a=1" });
}

describe("classify", () => {
  it("classifies every queueable route's POST as a queueable write naming its route", () => {
    for (const route of config.queueable) expect(classify(post(concrete(route)), config), route).toEqual({ kind: "queueable-write", route });
  });

  it("classifies every online-only route's POST as an online-only write naming its route", () => {
    for (const route of config.onlineOnly) expect(classify(post(concrete(route)), config), route).toEqual({ kind: "online-only-write", route });
  });

  it("classifies a POST sent by htmx by its route all the same", () => {
    expect(classify(post("/shopping/pantry", { "HX-Request": "true" }), config)).toEqual({ kind: "online-only-write", route: "/shopping/pantry" });
    expect(classify(post("/shopping/check", { "HX-Request": "true" }), config)).toEqual({ kind: "queueable-write", route: "/shopping/check" });
  });

  it("passes through a POST to a route in neither set", () => {
    expect(classify(post("/nowhere"), config)).toEqual({ kind: "passthrough" });
  });

  it("classifies every pre-warm page and every offline page as a cacheable page", () => {
    const prewarmed = config.prewarm.map((template) => template.replace("{thisWeek}", "2026-10-12").replace("{nextWeek}", "2026-10-19"));
    for (const path of [...prewarmed, ...config.pages.map(concrete), "/dishes/3/edit"]) {
      expect(classify(get(path), config), path).toEqual({ kind: "page", cacheable: true });
    }
  });

  it("classifies pages outside the offline set, such as Logs, Settings and Schools, as non-cacheable pages", () => {
    for (const path of ["/logs", "/settings", "/schools", "/dishes/3", "/dishes/3/edit/more"]) {
      expect(classify(get(path), config), path).toEqual({ kind: "page", cacheable: false });
    }
  });

  it("classifies assets and the manifest as assets", () => {
    for (const path of [...config.assets, "/assets/app.css?v=2"]) expect(classify(get(path), config), path).toEqual({ kind: "asset" });
  });

  it("passes through htmx GETs, the Plan Run banner, the log stream, the health check and the worker itself", () => {
    for (const request of [get("/shopping", { "HX-Request": "true" }), get("/plan-run/banner"), get("/logs/stream"), get("/health"), get("/sw.js")]) {
      expect(classify(request, config), request.url).toEqual({ kind: "passthrough" });
    }
  });
});

describe("prewarmUrls", () => {
  it("fills in this week's and next week's ISO Mondays from a mid-week today", () => {
    expect(prewarmUrls(config.prewarm, "2026-10-17")).toEqual([
      "/",
      "/plan?week=2026-10-12",
      "/plan?week=2026-10-19",
      "/shopping?week=2026-10-12",
      "/shopping?week=2026-10-19",
      "/dishes",
      "/pantry",
    ]);
  });

  it("treats a Monday as its own week and crosses a year end", () => {
    expect(prewarmUrls(["/plan?week={thisWeek}", "/plan?week={nextWeek}"], "2026-10-12")).toEqual(["/plan?week=2026-10-12", "/plan?week=2026-10-19"]);
    expect(prewarmUrls(["/plan?week={thisWeek}", "/plan?week={nextWeek}"], "2026-12-31")).toEqual(["/plan?week=2026-12-28", "/plan?week=2027-01-04"]);
  });
});

describe("cacheKeysFor", () => {
  it("tries Plan and Shopping without a week as this week's pre-warmed copy too", () => {
    expect(cacheKeysFor(`${ORIGIN}/plan`, "2026-10-17")).toEqual([`${ORIGIN}/plan`, `${ORIGIN}/plan?week=2026-10-12`]);
    expect(cacheKeysFor(`${ORIGIN}/shopping`, "2026-10-18")).toEqual([`${ORIGIN}/shopping`, `${ORIGIN}/shopping?week=2026-10-12`]);
  });

  it("tries only the URL itself for other pages and for a named week", () => {
    expect(cacheKeysFor(`${ORIGIN}/`, "2026-10-17")).toEqual([`${ORIGIN}/`]);
    expect(cacheKeysFor(`${ORIGIN}/dishes/3/edit`, "2026-10-17")).toEqual([`${ORIGIN}/dishes/3/edit`]);
    expect(cacheKeysFor(`${ORIGIN}/shopping?week=2026-10-19`, "2026-10-17")).toEqual([`${ORIGIN}/shopping?week=2026-10-19`]);
  });
});

describe("offlineResponseFor", () => {
  const cacheablePage = { kind: "page", cacheable: true } as const;

  it("answers a cacheable page that has a copy with the copy, bannered with its fetched-at time", async () => {
    const html = await renderedPage("/shopping");

    const res = offlineResponseFor(cacheablePage, { config, lang: "sv", copy: { html, fetchedAt: "2026-10-17T05:45:00.000Z" }, formatTime: () => "07:45" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(html.replace(MARKER, '<div id="offline-banner" class="notice" role="status">Visas från kopia, uppdaterad 07:45</div>'));
  });

  it("formats the fetched-at time as the device's local HH:MM by default, in the copy's language", async () => {
    const fetchedAt = new Date(2026, 9, 17, 7, 5).toISOString();

    const res = offlineResponseFor(cacheablePage, { config, lang: "en", copy: { html: `<main>${MARKER}</main>`, fetchedAt } });

    expect(await res.text()).toContain(">Shown from copy, updated 07:05</div>");
  });

  it("answers a cacheable page without a copy with the requires-connection page and a back link", async () => {
    const res = offlineResponseFor(cacheablePage, { config, lang: "sv", back: "/plan" });

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toMatch(/^<!doctype html>/);
    expect(body).toContain("<p>Kräver uppkoppling</p>");
    expect(body).toContain('<a href="/plan">Tillbaka</a>');
    expect(body).not.toContain("{{");
  });

  it("answers Logs, Settings and Schools with the requires-connection page even when a copy exists, linking back home", async () => {
    const res = offlineResponseFor({ kind: "page", cacheable: false }, { config, lang: "en", copy: { html: "<p>stale</p>", fetchedAt: "2026-10-17T05:45:00.000Z" } });

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("<p>Requires connection</p>");
    expect(body).toContain('<a href="/">Back</a>');
    expect(body).not.toContain("stale");
  });

  it("answers an online-only form post with the requires-connection page", async () => {
    const res = offlineResponseFor({ kind: "online-only-write", route: "/plan/generate" }, { config, lang: "sv", back: "/plan" });

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("<p>Kräver uppkoppling</p>");
  });

  it("answers an online-only write sent by htmx with an empty 204, so no page lands in a fragment target", async () => {
    const res = offlineResponseFor({ kind: "online-only-write", route: "/shopping/pantry" }, { config, lang: "sv", htmx: true, back: "/shopping" });

    expect(res.status).toBe(204);
    expect(res.headers.get("HX-Redirect")).toBeNull();
    expect(await res.text()).toBe("");
  });

  it("answers a queueable write sent by htmx with an empty 204 that sends the page to the saved page, linking back", async () => {
    const res = offlineResponseFor({ kind: "queueable-write", route: "/dishes/:id/promote" }, { config, lang: "sv", htmx: true, back: "/dishes?q=a b" });

    expect(res.status).toBe(204);
    expect(res.headers.get("HX-Redirect")).toBe("/offline/saved?back=%2Fdishes%3Fq%3Da%20b");
    expect(await res.text()).toBe("");
  });

  it("answers a queueable write sent by htmx without a back path with a saved page linking home", () => {
    const res = offlineResponseFor({ kind: "queueable-write", route: "/dishes/:id/promote" }, { config, lang: "sv", htmx: true });

    expect(res.headers.get("HX-Redirect")).toBe("/offline/saved?back=%2F");
  });

  it("answers a queueable form post in Swedish with the Swedish saved page", async () => {
    const res = offlineResponseFor({ kind: "queueable-write", route: "/dishes/:id" }, { config, lang: "sv", back: "/dishes/7/edit" });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^<!doctype html>/);
    expect(body).toContain("<p>Sparat, synkas nästa gång appen når hemmanätet</p>");
    expect(body).toContain('<a href="/dishes/7/edit">Tillbaka</a>');
    expect(body).not.toContain("{{");
  });

  it("answers a queueable form post with the saved page", async () => {
    const res = offlineResponseFor({ kind: "queueable-write", route: "/shopping/check" }, { config, lang: "en", back: "/shopping" });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<p>Saved, will sync when the app next reaches home</p>");
    expect(body).toContain('<a href="/shopping">Back</a>');
  });

  it("answers passthrough requests with an empty 204 and assets with a 404", async () => {
    const passthrough = offlineResponseFor({ kind: "passthrough" }, { config, lang: "sv" });
    expect(passthrough.status).toBe(204);
    expect(await passthrough.text()).toBe("");
    expect(offlineResponseFor({ kind: "asset" }, { config, lang: "sv" }).status).toBe(404);
  });
});

describe("backPath", () => {
  it("keeps the path and query of a same-origin referrer", () => {
    expect(backPath(`${ORIGIN}/shopping?week=2026-10-19`, ORIGIN)).toBe("/shopping?week=2026-10-19");
    expect(backPath(`${ORIGIN}/dishes/7/edit#top`, ORIGIN)).toBe("/dishes/7/edit");
  });

  it("keeps a plain path, as a ?back= query carries it", () => {
    expect(backPath("/pantry", ORIGIN)).toBe("/pantry");
  });

  it("goes home for no referrer, another origin, a protocol-relative path or a non-http scheme", () => {
    for (const value of [null, undefined, "", "https://evil.example/x", "//evil.example/x", "javascript:alert(1)"]) {
      expect(backPath(value, ORIGIN), String(value)).toBe("/");
    }
  });
});

describe("extractLang", () => {
  it("reads the language of a rendered page", async () => {
    expect(extractLang(await renderedPage("/", "en"))).toBe("en");
    expect(extractLang(await renderedPage("/", "sv"))).toBe("sv");
  });

  it("defaults to Swedish when the page names no language", () => {
    expect(extractLang("<!doctype html><html><body></body></html>")).toBe("sv");
    expect(extractLang("")).toBe("sv");
  });
});

describe("injectBanner", () => {
  it("puts exactly one Swedish banner at the marker of a rendered Shopping page and leaves the rest alone", async () => {
    const html = await renderedPage("/shopping");
    const [before, after] = html.split(MARKER);

    const out = injectBanner(html, "Visas från kopia, uppdaterad 07:45");

    const banner = '<div id="offline-banner" class="notice" role="status">Visas från kopia, uppdaterad 07:45</div>';
    expect(out.split(banner)).toEqual([before, after]);
    expect(out).not.toContain(MARKER);
  });

  it("puts the English banner on an English page", async () => {
    const html = await renderedPage("/shopping", "en");
    const text = config.texts.en.banner.replace("{time}", "21:05");

    const out = injectBanner(html, text);

    expect(out.split('<div id="offline-banner" class="notice" role="status">Shown from copy, updated 21:05</div>')).toEqual(html.split(MARKER));
  });

  it("escapes the text and returns a page without the marker unchanged", () => {
    expect(injectBanner(`<main>${MARKER}</main>`, "a < b")).toBe('<main><div id="offline-banner" class="notice" role="status">a &lt; b</div></main>');
    expect(injectBanner("<main></main>", "x")).toBe("<main></main>");
  });
});
