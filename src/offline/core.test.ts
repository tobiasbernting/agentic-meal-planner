import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activateTab, backPath, cacheKeysFor, classify, extractLang, firstAttemptRequest, injectBanner, newPendingChange, offlineResponseFor, overlayPendingChanges, prewarmUrls, replayOrder, replayOutcome, replayRequest, routeLabel } from "../../public/offline/core.js";
import { buildApp } from "../app.js";
import { notice, page } from "../ui/layout.js";
import { workerConfig } from "./routes.js";

const config = workerConfig();
const ORIGIN = "http://meals.lan:8080";
const MARKER = config.marker;
/** The Offline Copy banner's opening tag: a quiet status, not a failure notice. */
const BANNER = '<div id="offline-banner" class="offline-banner" role="status">';
/** A rendered page as the Offline Copy serves it: started offline. */
const offline = (html: string) => html.replace('data-online="1"', 'data-online="0"');

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
    expect(classify(post("/shopping/push", { "HX-Request": "true" }), config)).toEqual({ kind: "online-only-write", route: "/shopping/push" });
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

  it("classifies the worker's own saved and requires-connection pages as offline pages, whatever the query", () => {
    expect(classify(get("/offline/saved?back=%2Fdishes"), config)).toEqual({ kind: "offline-page", page: "saved" });
    expect(classify(get("/offline/saved"), config)).toEqual({ kind: "offline-page", page: "saved" });
    expect(classify(get("/offline/requires-connection?back=%2F"), config)).toEqual({ kind: "offline-page", page: "requiresConnection" });
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
      "/shopping",
      "/lists",
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
  it("tries Plan without a week as this week's pre-warmed copy too; the Shopping List has no weeks", () => {
    expect(cacheKeysFor(`${ORIGIN}/plan`, "2026-10-17")).toEqual([`${ORIGIN}/plan`, `${ORIGIN}/plan?week=2026-10-12`]);
    expect(cacheKeysFor(`${ORIGIN}/shopping`, "2026-10-18")).toEqual([`${ORIGIN}/shopping`]);
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
    expect(await res.text()).toBe(offline(html).replace(MARKER, `${BANNER}Visas från kopia, uppdaterad 07:45</div>`));
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
    expect(body).toContain('<a class="button" href="/plan">Tillbaka</a>');
    expect(body).toMatch(/<a href="\/plan" aria-current="page">Plan<\/a>/);
    expect(body).not.toContain("{{");
  });

  it("answers Logs, Settings and Schools with the requires-connection page even when a copy exists, linking back home", async () => {
    const res = offlineResponseFor({ kind: "page", cacheable: false }, { config, lang: "en", copy: { html: "<p>stale</p>", fetchedAt: "2026-10-17T05:45:00.000Z" } });

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("<p>Requires connection</p>");
    expect(body).toContain('<a class="button" href="/">Back</a>');
    expect(body).not.toContain("stale");
  });

  it("answers an online-only form post with the requires-connection page", async () => {
    const res = offlineResponseFor({ kind: "online-only-write", route: "/plan/generate" }, { config, lang: "sv", back: "/plan" });

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("<p>Kräver uppkoppling</p>");
  });

  it("answers an online-only write sent by htmx with an empty 204 that sends the page to the requires-connection page, linking back", async () => {
    const res = offlineResponseFor({ kind: "online-only-write", route: "/shopping/pantry" }, { config, lang: "sv", htmx: true, back: "/shopping?week=2026-10-19" });

    expect(res.status).toBe(204);
    expect(res.headers.get("HX-Redirect")).toBe("/offline/requires-connection?back=%2Fshopping%3Fweek%3D2026-10-19");
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
    expect(body).toContain('<a class="button" href="/dishes/7/edit">Tillbaka</a>');
    expect(body).not.toContain("{{");
  });

  it("answers a queueable form post outside the Shopping List with the saved page", async () => {
    const res = offlineResponseFor({ kind: "queueable-write", route: "/pantry" }, { config, lang: "en", back: "/pantry" });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<p>Saved, will sync when the app next reaches home</p>");
    expect(body).toContain('<a class="button" href="/pantry">Back</a>');
  });

  it("renders the worker's own saved page with its back link", async () => {
    const back = backPath(new URL(`${ORIGIN}/offline/saved?back=%2Fdishes%3Fq%3Da`).searchParams.get("back"), ORIGIN);

    const res = offlineResponseFor({ kind: "offline-page", page: "saved" }, { config, lang: "en", back });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("<p>Saved, will sync when the app next reaches home</p>");
    expect(body).toContain('<a class="button" href="/dishes?q=a">Back</a>');
  });

  it("renders the worker's own requires-connection page, linking home when the back query is foreign", async () => {
    const back = backPath(new URL(`${ORIGIN}/offline/requires-connection?back=https%3A%2F%2Fevil.example%2F`).searchParams.get("back"), ORIGIN);

    const res = offlineResponseFor({ kind: "offline-page", page: "requiresConnection" }, { config, lang: "sv", back });

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("<p>Kräver uppkoppling</p>");
    expect(body).toContain('<a class="button" href="/">Tillbaka</a>');
  });

  it("answers an htmx passthrough request with an empty 204, so htmx polling stays quiet", async () => {
    const passthrough = offlineResponseFor({ kind: "passthrough" }, { config, lang: "sv", htmx: true });

    expect(passthrough.status).toBe(204);
    expect(await passthrough.text()).toBe("");
  });

  it("answers any other passthrough request, such as the online signal's health ping, with an empty 503 that is not ok", async () => {
    const passthrough = offlineResponseFor({ kind: "passthrough" }, { config, lang: "sv" });

    expect(passthrough.status).toBe(503);
    expect(passthrough.ok).toBe(false);
    expect(await passthrough.text()).toBe("");
  });

  it("answers assets with a 404", () => {
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

    const out = injectBanner(html, "Visas från kopia, uppdaterad 07:45", MARKER);

    const banner = `${BANNER}Visas från kopia, uppdaterad 07:45</div>`;
    expect(out.split(banner)).toEqual([offline(before!), after]);
    expect(out).not.toContain(MARKER);
  });

  it("puts the English banner on an English page", async () => {
    const html = await renderedPage("/shopping", "en");
    const text = config.texts.en.banner.replace("{time}", "21:05");

    const out = injectBanner(html, text, MARKER);

    expect(out.split(`${BANNER}Shown from copy, updated 21:05</div>`)).toEqual(offline(html).split(MARKER));
  });

  it("escapes the text and returns a page without the marker unchanged", () => {
    expect(injectBanner(`<main>${MARKER}</main>`, "a < b", MARKER)).toBe(`<main>${BANNER}a &lt; b</div></main>`);
    expect(injectBanner("<main></main>", "x", MARKER)).toBe("<main></main>");
  });

  it("starts a bannered page offline: the html tag says data-online=\"0\", once", async () => {
    const html = await renderedPage("/shopping");

    const out = injectBanner(html, "x", MARKER);

    expect(out.split('data-online="0"').length - 1).toBe(1);
    expect(out).not.toContain('data-online="1"');
    expect(out).toMatch(/<html lang="sv" data-online="0">/);
  });
});

/** A stored Pending Change, as newPendingChange builds it. */
function entry(id: string, createdAt: string) {
  return { id, method: "POST", url: "/pantry", body: "name=salt", contentType: "application/x-www-form-urlencoded", key: `key-${id}`, createdAt, state: "pending" };
}

describe("newPendingChange", () => {
  it("stores a failed form post as a pending POST with its own id and a separate Idempotency-Key", () => {
    const ids = ["0f1e2d3c-0000-4000-8000-00000000000a", "0f1e2d3c-0000-4000-8000-00000000000b"];

    const change = newPendingChange({
      url: `${ORIGIN}/pantry`,
      body: "name=Salt&category=spices",
      contentType: "application/x-www-form-urlencoded",
      now: new Date("2026-10-17T07:45:00.000Z"),
      uuid: () => ids.shift() ?? "",
    });

    expect(change).toEqual({
      id: "0f1e2d3c-0000-4000-8000-00000000000a",
      method: "POST",
      url: `${ORIGIN}/pantry`,
      body: "name=Salt&category=spices",
      contentType: "application/x-www-form-urlencoded",
      key: "0f1e2d3c-0000-4000-8000-00000000000b",
      createdAt: "2026-10-17T07:45:00.000Z",
      state: "pending",
    });
  });

  it("replays as the request it was built from", async () => {
    const change = newPendingChange({ url: `${ORIGIN}/dishes/7`, body: "name=Soup", contentType: "application/x-www-form-urlencoded", now: new Date(), uuid: () => crypto.randomUUID() });
    const { url, init } = replayRequest(change);
    const request = new Request(url, init);

    expect([request.url, request.method, request.headers.get("Idempotency-Key"), await request.text()]).toEqual([`${ORIGIN}/dishes/7`, "POST", change.key, "name=Soup"]);
    expect(change.key).not.toBe(change.id);
  });
});

describe("firstAttemptRequest", () => {
  const change = { ...entry("f1", "2026-10-17T07:00:00.000Z"), url: `${ORIGIN}/shopping/check`, body: "weekStart=2026-10-19&name=ost", key: "5c1d0e2f-0000-4000-8000-000000000002" };

  it("sends the first attempt with the same Idempotency-Key a later replay carries", () => {
    const first = firstAttemptRequest(change, post("/shopping/check"));
    const replay = replayRequest(change);

    expect(new Headers(first.init.headers).get("Idempotency-Key")).toBe(change.key);
    expect(new Headers(replay.init.headers).get("Idempotency-Key")).toBe(change.key);
  });

  it("keeps the original request's headers and redirect mode, and sends the stored body", async () => {
    const original = new Request(`${ORIGIN}/dishes/7/promote`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "HX-Request": "true" }, body: "x=1", redirect: "manual" });

    const { url, init } = firstAttemptRequest({ ...change, url: original.url, body: "x=1" }, original);
    const request = new Request(url, init);

    expect([request.url, request.method, request.redirect, request.headers.get("HX-Request"), request.headers.get("content-type")]).toEqual([
      `${ORIGIN}/dishes/7/promote`,
      "POST",
      "manual",
      "true",
      "application/x-www-form-urlencoded",
    ]);
    expect(await request.text()).toBe("x=1");
  });
});

describe("replayOrder", () => {
  it("replays the oldest Pending Change first", () => {
    const queue = [entry("c", "2026-10-17T09:00:00.000Z"), entry("a", "2026-10-17T07:00:00.000Z"), entry("b", "2026-10-17T08:00:00.000Z")];

    expect(replayOrder(queue).map((e: { id: string }) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps stored order for Pending Changes made in the same millisecond", () => {
    const queue = [entry("x", "2026-10-17T08:00:00.000Z"), entry("early", "2026-10-17T07:00:00.000Z"), entry("y", "2026-10-17T08:00:00.000Z"), entry("z", "2026-10-17T08:00:00.000Z")];

    expect(replayOrder(queue).map((e: { id: string }) => e.id)).toEqual(["early", "x", "y", "z"]);
  });

  it("leaves the queue it was given alone", () => {
    const queue = [entry("b", "2026-10-17T08:00:00.000Z"), entry("a", "2026-10-17T07:00:00.000Z")];

    replayOrder(queue);

    expect(queue.map((e) => e.id)).toEqual(["b", "a"]);
  });
});

describe("replayRequest", () => {
  const stored = { ...entry("p1", "2026-10-17T07:00:00.000Z"), url: `${ORIGIN}/dishes/7`, body: "name=Pasta+bake&tags=quick", key: "3b2f1c9e-0000-4000-8000-000000000001" };

  it("rebuilds the stored POST with its form body, content type and Idempotency-Key, following redirects", async () => {
    const { url, init } = replayRequest(stored);
    const request = new Request(url, init);

    expect(request.url).toBe(`${ORIGIN}/dishes/7`);
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("follow");
    expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(request.headers.get("Idempotency-Key")).toBe("3b2f1c9e-0000-4000-8000-000000000001");
    expect(await request.text()).toBe("name=Pasta+bake&tags=quick");
  });

  it("carries the same stored Idempotency-Key on every replay attempt", () => {
    const keys = [1, 2, 3].map(() => new Headers(replayRequest(stored).init.headers).get("Idempotency-Key"));

    expect(keys).toEqual([stored.key, stored.key, stored.key]);
  });
});

describe("replayOutcome", () => {
  it("drops a Pending Change the server took, whether it answered 2xx or redirected", () => {
    for (const status of [200, 201, 204, 302, 303]) expect(replayOutcome(status, ""), String(status)).toEqual({ kind: "drop" });
  });

  it("marks a Pending Change the server refused as failed, carrying the page's notice text unescaped", () => {
    const body = page({ title: "Rätter", tab: "dishes", lang: "sv", body: notice({ label: "Misslyckades", text: "Namnet finns redan: \"Pasta & ost\" <1>" }) });

    expect(replayOutcome(400, body)).toEqual({ kind: "failed", reason: 'Namnet finns redan: "Pasta & ost" <1>' });
  });

  it("names the status when a refused Pending Change's page has no notice", () => {
    expect(replayOutcome(404, "<!doctype html><p>Not found</p>")).toEqual({ kind: "failed", reason: "HTTP 404" });
    expect(replayOutcome(422, "")).toEqual({ kind: "failed", reason: "HTTP 422" });
  });

  it("keeps a Pending Change for next time when no response came back at all", () => {
    expect(replayOutcome(undefined, "")).toEqual({ kind: "keep" });
  });

  it("keeps a Pending Change for next time when the server failed", () => {
    for (const status of [500, 502, 503]) expect(replayOutcome(status, notice({ text: "oops" })), String(status)).toEqual({ kind: "keep" });
  });
});

describe("routeLabel", () => {
  it("labels every queueable route in both languages", () => {
    for (const lang of ["sv", "en"] as const) {
      for (const pattern of config.queueable) {
        const path = pattern.replace(/:[^/]+/g, "12");
        const label = routeLabel("POST", path, config, lang);
        expect(label, `${lang} ${pattern}`).not.toBe("");
        expect(label, `${lang} ${pattern}`).not.toBe(config.texts[lang].unknownChange);
      }
    }
  });

  it("resolves a dish edit and a dish delete to their own labels", () => {
    expect(routeLabel("POST", "/dishes/12", config, "en")).toBe("Edit dish");
    expect(routeLabel("POST", "/dishes/12/delete", config, "en")).toBe("Delete dish");
    expect(routeLabel("POST", "/dishes/12/delete", config, "sv")).toBe(config.labels.sv["/dishes/:id/delete"]);
  });

  it("falls back to the generic label for an unknown route or a non-POST", () => {
    expect(routeLabel("POST", "/nowhere", config, "en")).toBe("Change");
    expect(routeLabel("GET", "/dishes/12", config, "sv")).toBe("Ändring");
  });
});

describe("overlayPendingChanges", () => {
  const change = (path: string, fields: Record<string, string>) =>
    newPendingChange({ url: ORIGIN + path, body: new URLSearchParams(fields).toString(), contentType: "application/x-www-form-urlencoded", now: new Date(2026, 9, 17, 9, 0), uuid: () => "u" });
  const texts = config.texts.sv;

  /** A Shopping copy: Buy has pasta and the hand-added batteries (ticked); Check pantry has mjölk. Returns the html and the line ids by name. */
  async function shoppingCopy(): Promise<{ html: string; id: Record<string, string> }> {
    const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "mp-offline-overlay-")), now: () => new Date(2026, 9, 14, 18, 30), logLevel: "info", logDestination: { write: () => true } });
    apps.push(app);
    const { createDish } = await import("../dishes/repo.js");
    const { createPantryItem } = await import("../pantry/repo.js");
    const { planWeek, updateList } = await import("../shopping/test-helpers.js");
    const pasta = createDish(app.ctx.db, { name: "Pasta", ingredients: [{ name: "pasta", quantity: 400, unit: "g" }, { name: "mjölk", quantity: 2, unit: "dl" }] });
    createPantryItem(app.ctx.db, { name: "mjölk", aliases: [] });
    await updateList(app, planWeek(app.ctx.db, "2026-10-12", [pasta], "2026-10-11T18:00:00Z"));
    await app.inject({ method: "POST", url: "/shopping/add", payload: { name: "batteries", quantity: "2 pack" } });
    let html = (await app.inject({ method: "GET", url: "/shopping" })).body;
    const idOf = (name: string) => new RegExp(`data-line="(\\d+)" data-name="${name}"`).exec(html)![1]!;
    const id = { pasta: idOf("pasta"), mjölk: idOf("mjölk"), batteries: idOf("batteries") };
    await app.inject({ method: "POST", url: "/shopping/check", payload: { id: id.batteries } });
    html = (await app.inject({ method: "GET", url: "/shopping" })).body;
    return { html, id };
  }

  const line = (html: string, id: string) => new RegExp(`<li class="row line[^"]*" data-line="${id}"[^>]*>[\\s\\S]*?</li>`).exec(html)?.[0] ?? "";

  it("shows a pending check struck through with a pending mark, and flips its form to uncheck", async () => {
    const { html: copy, id } = await shoppingCopy();
    const html = overlayPendingChanges(copy, [change("/shopping/check", { id: id.pasta })], texts);
    const pasta = line(html, id.pasta);
    expect(pasta).toMatch(/^<li class="row line line-checked line-pending"/);
    expect(pasta).toContain('action="/shopping/uncheck" hx-post="/shopping/uncheck"');
    expect(pasta).not.toContain("/shopping/check\"");
    expect(pasta).toContain('aria-pressed="true"');
    expect(pasta).toMatch(/<s class="row-label">400 g pasta<\/s><span class="row-status pending-mark">väntar<\/span>/);
    expect(line(html, id.mjölk)).not.toContain("line-checked");
  });

  it("shows a pending uncheck as open again, with one mark", async () => {
    const { html: copy, id } = await shoppingCopy();
    const checked = overlayPendingChanges(copy, [change("/shopping/check", { id: id.pasta })], texts);
    const html = overlayPendingChanges(checked, [change("/shopping/uncheck", { id: id.pasta })], texts);
    const pasta = line(html, id.pasta);
    expect(pasta).toMatch(/^<li class="row line line-pending"/);
    expect(pasta).toContain('action="/shopping/check"');
    expect(pasta).toMatch(/<span class="row-label">400 g pasta<\/span><span class="row-status pending-mark">väntar<\/span>/);
    expect(pasta.match(/pending-mark/g)).toHaveLength(1);
  });

  it("shows a pending Delete as a muted line with a mark, once", async () => {
    const { html: copy, id } = await shoppingCopy();
    const html = overlayPendingChanges(copy, [change("/shopping/delete", { id: id.mjölk }), change("/shopping/delete", { id: id.mjölk })], texts);
    const mjolk = line(html, id.mjölk);
    expect(mjolk).toMatch(/^<li class="row line line-removed line-pending"/);
    expect(mjolk.match(/pending-mark/g)).toHaveLength(1);
    expect(line(html, id.pasta)).not.toContain("line-removed");
  });

  it("lists a pending hand-add first in Buy, before the Store Sections and the ticked lines, with its quantity text, escaped, and hides the ticked lines on a pending Clear", async () => {
    const { html: copy, id } = await shoppingCopy();
    const added = overlayPendingChanges(copy, [change("/shopping/add", { name: "<candles>", quantity: "2 pack" }), change("/shopping/add", { name: "tape" })], texts);
    const buy = /<section id="buy">[\s\S]*?<\/section>/.exec(added)![0];
    expect(buy).toMatch(
      /^<section id="buy"><h2 class="section-label">Köp<\/h2>\n<ul class="rows pending-adds">\n<li class="row line line-pending"><div class="line-body"><span class="row-label">2 pack &lt;candles&gt;<\/span><span class="row-status pending-mark">väntar<\/span><\/div><\/li>\n<li class="row line line-pending"><div class="line-body"><span class="row-label">tape<\/span>[\s\S]*?<\/li>\n<\/ul>\n<h3 class="aisle-label">/,
    );

    const cleared = overlayPendingChanges(copy, [change("/shopping/clear", {})], texts);
    expect(line(cleared, id.batteries)).toMatch(/^<li class="row line line-checked" data-line="\d+" data-name="batteries" hidden>/);
    expect(line(cleared, id.pasta)).toMatch(/^<li class="row line" data-line="\d+" data-name="pasta">/);
  });

  it("ignores non-Shopping changes and a page that is not a Shopping copy", async () => {
    const { html: copy, id } = await shoppingCopy();
    const dish = newPendingChange({ url: ORIGIN + "/dishes/3", body: "name=X", contentType: "application/x-www-form-urlencoded", now: new Date(), uuid: () => "u" });
    expect(overlayPendingChanges(copy, [dish], texts)).toBe(copy);
    const today = await renderedPage("/");
    expect(overlayPendingChanges(today, [change("/shopping/check", { id: id.pasta })], texts)).toBe(today);
  });
});

describe("offlineResponseFor with Pending Changes", () => {
  it("answers a Shopping List edit with a 303 back to the list, not a page", async () => {
    const res = offlineResponseFor({ kind: "queueable-write", route: "/shopping/check" }, { config, lang: "sv", back: "/shopping" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/shopping");
    expect(await res.text()).toBe("");
  });

  it("folds the number of Pending Changes into the copy's banner", async () => {
    const html = await renderedPage("/pantry");
    const pending = [1, 2, 3].map((n) => newPendingChange({ url: ORIGIN + "/pantry", body: `name=${n}`, contentType: "x", now: new Date(2026, 9, 17, 9, 0, n), uuid: () => `u${n}` }));
    const copy = { html, fetchedAt: "2026-10-17T05:45:00.000Z" };
    const three = await offlineResponseFor({ kind: "page", cacheable: true }, { config, lang: "sv", copy, pending, formatTime: () => "07:45" }).text();
    const one = await offlineResponseFor({ kind: "page", cacheable: true }, { config, lang: "sv", copy, pending: pending.slice(0, 1), formatTime: () => "07:45" }).text();
    expect(three).toContain(`${BANNER}Visas från kopia, uppdaterad 07:45 · 3 ändringar väntar</div>`);
    expect(one).toContain("07:45 · 1 ändring väntar</div>");
  });
});

describe("the worker's own pages", () => {
  it("activateTab moves aria-current to the tab a back path belongs to and leaves the rest alone", () => {
    const saved = config.frames.sv.saved;
    const shopping = activateTab(saved, "/shopping?week=2026-10-12");
    expect(shopping).toMatch(/<a href="\/shopping" aria-current="page">Inköp<\/a>/);
    expect(shopping).not.toMatch(/<a href="\/" aria-current="page">/);
    expect(activateTab(saved, "/dishes/3/edit")).toMatch(/<a href="\/more" aria-current="page">Mer<\/a>/);
    expect(activateTab(saved, "/plan")).toMatch(/<a href="\/plan" aria-current="page">Plan<\/a>/);
    expect(activateTab(saved, "/")).toBe(saved);
    expect(shopping.replace(' aria-current="page"', "")).toBe(saved.replace(' aria-current="page"', ""));
  });

  it("renders the saved page for a Dish edit under Mer, with a heading, a short title, a button back and started offline", async () => {
    const res = offlineResponseFor({ kind: "queueable-write", route: "/dishes/:id" }, { config, lang: "sv", back: "/dishes/3/edit" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<title>Sparat - Måltidsplaneraren</title>");
    expect(body).toContain('<header class="page-head"><h1>Sparat</h1></header>');
    expect(body).toContain("Sparat, synkas nästa gång appen når hemmanätet");
    expect(body).toContain('<a class="button" href="/dishes/3/edit">Tillbaka</a>');
    expect(body).toContain('data-online="0"');
    expect(body).toMatch(/<a href="\/more" aria-current="page">Mer<\/a>/);
  });
});
