// The offline service worker's decisions (ADR-0007), as pure functions: no `self`, no caches,
// no IndexedDB. public/offline/worker.js is the glue that calls them; src/offline/core.test.ts
// tests them. Served at /assets/offline-core.js. `config` is `self.OFFLINE_CONFIG`, built by
// workerConfig() in src/offline/routes.ts.

/** GETs that are neither pages nor assets: streams, polls and probes the worker never answers itself. */
const PASSTHROUGH_PATHS = ["/plan-run/banner", "/logs/stream", "/health", "/sw.js"];

const MANIFEST_PATH = "/manifest.webmanifest";

/** The empty element page() in src/ui/layout.ts puts once on every page. */
const BANNER_MARKER = '<div id="offline-banner"></div>';

/** @param {string} text */
function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/**
 * Fills a frame from config.frames: `{{back}}` is the back link's href, `{{text}}` the message.
 * @param {string} frame
 * @param {string} text
 * @param {string} back
 */
function fillFrame(frame, text, back) {
  return frame.replaceAll("{{back}}", escapeHtml(back)).replaceAll("{{text}}", escapeHtml(text));
}

/**
 * Whether a path matches a Fastify route pattern: same segment count, `:param` matches any one
 * segment, everything else exactly.
 * @param {string} pattern
 * @param {string} path
 */
function matchesRoute(pattern, path) {
  const want = pattern.split("/");
  const have = path.split("/");
  return want.length === have.length && want.every((part, i) => part.startsWith(":") ? have[i] !== "" : part === have[i]);
}

/**
 * @param {readonly string[]} patterns
 * @param {string} path
 * @returns {string | undefined} the first pattern the path matches
 */
function findRoute(patterns, path) {
  return patterns.find((pattern) => matchesRoute(pattern, path));
}

/**
 * What the worker should do with a request.
 * @param {Request} request
 * @param {{ queueable: string[], onlineOnly: string[], pages: string[] }} config
 * @returns {{ kind: "asset" } | { kind: "page", cacheable: boolean } | { kind: "queueable-write" | "online-only-write", route: string } | { kind: "passthrough" }}
 */
export function classify(request, config) {
  const path = new URL(request.url).pathname;
  if (request.method === "POST") {
    const queueable = findRoute(config.queueable, path);
    if (queueable) return { kind: "queueable-write", route: queueable };
    const onlineOnly = findRoute(config.onlineOnly, path);
    if (onlineOnly) return { kind: "online-only-write", route: onlineOnly };
    return { kind: "passthrough" };
  }
  if (request.method !== "GET") return { kind: "passthrough" };
  if (path.startsWith("/assets/") || path === MANIFEST_PATH) return { kind: "asset" };
  if (request.headers.has("HX-Request") || PASSTHROUGH_PATHS.includes(path)) return { kind: "passthrough" };
  return { kind: "page", cacheable: findRoute(config.pages, path) !== undefined };
}

/**
 * @param {string} date "YYYY-MM-DD"
 * @param {number} days
 */
function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The ISO Monday of the week containing `date` (UTC arithmetic, like src/week.ts).
 * @param {string} date "YYYY-MM-DD"
 */
function mondayOf(date) {
  const sundayFirst = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((sundayFirst + 6) % 7));
}

/** Pages whose server default is this week, so `?week=<this Monday>` is the same page. */
const WEEK_PAGES = ["/plan", "/shopping"];

/**
 * The pre-warm list with `{thisWeek}` and `{nextWeek}` filled in.
 * @param {readonly string[]} templates
 * @param {string} today "YYYY-MM-DD" on the device clock
 */
export function prewarmUrls(templates, today) {
  const thisWeek = mondayOf(today);
  const nextWeek = addDays(thisWeek, 7);
  return templates.map((template) => template.replaceAll("{thisWeek}", thisWeek).replaceAll("{nextWeek}", nextWeek));
}

/**
 * Cache keys to try, in order, for a page's Offline Copy: the URL itself, then for Plan and
 * Shopping without a `?week` this week's pre-warmed copy.
 * @param {string} url absolute URL
 * @param {string} today "YYYY-MM-DD"
 */
export function cacheKeysFor(url, today) {
  const parsed = new URL(url);
  const keys = [parsed.href];
  if (WEEK_PAGES.includes(parsed.pathname) && !parsed.searchParams.has("week")) {
    parsed.searchParams.set("week", mondayOf(today));
    keys.push(parsed.href);
  }
  return keys;
}

/**
 * The page with the Offline Copy banner in place of the shell's marker; unchanged without one.
 * String replacement, not HTML parsing: user content is escaped, so it never contains the marker.
 * @param {string} html
 * @param {string} text
 */
export function injectBanner(html, text) {
  return html.replace(BANNER_MARKER, () => `<div id="offline-banner" class="notice" role="status">${escapeHtml(text)}</div>`);
}

/**
 * The language a page was rendered in, from `<html lang="xx">`; Swedish when it names none.
 * @param {string} html
 */
export function extractLang(html) {
  return /<html[^>]*\slang="([^"]+)"/.exec(html)?.[1] ?? "sv";
}

/**
 * `HH:MM` (24-hour) of an ISO timestamp on the device's clock.
 * @param {string} iso
 */
function localTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * @param {string} body
 * @param {number} status
 */
function htmlResponse(body, status) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

/**
 * The response the worker gives when the network failed.
 * @param {ReturnType<typeof classify>} classification
 * @param {{
 *   config: { texts: Record<string, Record<string, string>>, frames: Record<string, Record<string, string>> },
 *   lang: string,
 *   copy?: { html: string, fetchedAt: string },
 *   back?: string,
 *   htmx?: boolean,
 *   formatTime?: (iso: string) => string,
 * }} context `htmx`: the request carried the HX-Request header.
 * @returns {Response}
 */
export function offlineResponseFor(classification, context) {
  const { config, copy, back = "/", htmx = false, formatTime = localTime } = context;
  const lang = context.lang in config.frames ? context.lang : "sv";
  const texts = config.texts[lang];
  const frames = config.frames[lang];
  const requiresConnection = () => htmlResponse(fillFrame(frames.requiresConnection, texts.requiresConnection, back), 503);
  switch (classification.kind) {
    case "page":
      if (classification.cacheable && copy) return htmlResponse(injectBanner(copy.html, texts.banner.replaceAll("{time}", formatTime(copy.fetchedAt))), 200);
      return requiresConnection();
    case "online-only-write":
      return htmx ? new Response(null, { status: 204 }) : requiresConnection();
    case "queueable-write":
      return htmx ? new Response(null, { status: 204 }) : htmlResponse(fillFrame(frames.saved, texts.saved, back), 200);
    case "asset":
      return new Response(null, { status: 404 });
    default:
      return new Response(null, { status: 204 });
  }
}
