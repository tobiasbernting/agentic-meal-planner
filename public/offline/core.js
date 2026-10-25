// The offline service worker's decisions (ADR-0007), as pure functions: no `self`, no caches,
// no IndexedDB. public/offline/worker.js is the glue that calls them; src/offline/core.test.ts
// tests them. Served at /assets/offline-core.js. `config` is `self.OFFLINE_CONFIG`, built by
// workerConfig() in src/offline/routes.ts.

const MANIFEST_PATH = "/manifest.webmanifest";

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
 * The human label of a Pending Change, in the UI language: the label of the queueable route it
 * matches, else the generic "Change". Never blank.
 * @param {string} method
 * @param {string} path
 * @param {{ queueable: string[], labels: Record<string, Record<string, string>>, texts: Record<string, { unknownChange: string }> }} config
 * @param {string} lang
 */
export function routeLabel(method, path, config, lang) {
  const route = method === "POST" ? findRoute(config.queueable, path) : undefined;
  return (route && config.labels[lang]?.[route]) || config.texts[lang].unknownChange;
}

/**
 * What the worker should do with a request.
 * @param {Request} request
 * @param {{ queueable: string[], onlineOnly: string[], pages: string[], passthrough: string[], offlinePaths: { saved: string, requiresConnection: string } }} config
 * @returns {{ kind: "asset" } | { kind: "page", cacheable: boolean } | { kind: "offline-page", page: "saved" | "requiresConnection" } | { kind: "queueable-write" | "online-only-write", route: string } | { kind: "passthrough" }}
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
  if (path === config.offlinePaths.saved) return { kind: "offline-page", page: "saved" };
  if (path === config.offlinePaths.requiresConnection) return { kind: "offline-page", page: "requiresConnection" };
  if (request.headers.has("HX-Request") || config.passthrough.includes(path)) return { kind: "passthrough" };
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
const WEEK_PAGES = ["/plan"];

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
 * Cache keys to try, in order, for a page's Offline Copy: the URL itself, then for Plan without
 * a `?week` this week's pre-warmed copy.
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
 * The page with the Offline Copy banner in place of the shell's marker, started offline: the
 * `<html>` tag's `data-online="1"` becomes `"0"`, so the page's online signal begins there. A
 * page without the marker comes back unchanged. String replacement, not HTML parsing: user
 * content is escaped, so it never contains the marker or the attribute.
 * @param {string} html
 * @param {string} text
 * @param {string} marker config.marker, the empty element page() puts once on every page
 */
export function injectBanner(html, text, marker) {
  if (!html.includes(marker)) return html;
  return html
    .replace(/(<html\b[^>]*\s)data-online="1"/, '$1data-online="0"')
    .replace(marker, () => `<div id="offline-banner" class="offline-banner" role="status">${escapeHtml(text)}</div>`);
}

/** The tab bar href a path belongs to, for the worker's own pages. */
function tabFor(path) {
  if (path.startsWith("/plan")) return "/plan";
  if (path.startsWith("/shopping")) return "/shopping";
  if (/^\/(dishes|pantry|settings|schools|logs|more)\b/.test(path)) return "/more";
  return "/";
}

/**
 * The page with `aria-current` on the tab that `backPath` belongs to instead of wherever the
 * frame was rendered with it. Only the tab bar's links are touched.
 * @param {string} html
 * @param {string} backPath
 */
export function activateTab(html, backPath) {
  const href = tabFor(backPath);
  return html.replace(/<nav class="tabbar"[^>]*>[\s\S]*?<\/nav>/, (nav) =>
    nav.replaceAll(' aria-current="page"', "").replace(`<a href="${href}">`, `<a href="${href}" aria-current="page">`),
  );
}

/**
 * The Shopping List edit a Pending Change is, read from its route and form body; undefined for
 * any other change. Lines are keyed by id (ADR-0009), a hand-add by its typed name.
 * @param {PendingChange} entry
 * @returns {{ kind: "check" | "uncheck" | "delete" | "add" | "clear", id: string, name: string, quantity: string } | undefined}
 */
function shoppingEdit(entry) {
  const path = new URL(entry.url, "http://x").pathname;
  const kinds = { "/shopping/check": "check", "/shopping/uncheck": "uncheck", "/shopping/delete": "delete", "/shopping/add": "add", "/shopping/clear": "clear" };
  const kind = kinds[path];
  if (!kind) return undefined;
  const form = new URLSearchParams(entry.body);
  return { kind, id: form.get("id") ?? "", name: (form.get("name") ?? "").trim(), quantity: (form.get("quantity") ?? "").trim() };
}

/** The quiet "väntar" mark after a line's label. @param {string} text */
function pendingMark(text) {
  return `<span class="row-status pending-mark">${escapeHtml(text)}</span>`;
}

/**
 * One `<li ...>...</li>` of the list, rewritten. Lines never nest, so the first `</li>` after the
 * opening tag closes it.
 * @param {string} html
 * @param {string} openTag the exact opening tag to find
 * @param {(li: string) => string} rewrite
 */
function rewriteLine(html, openTag, rewrite) {
  const start = html.indexOf(openTag);
  if (start === -1) return html;
  const end = html.indexOf("</li>", start) + "</li>".length;
  return html.slice(0, start) + rewrite(html.slice(start, end)) + html.slice(end);
}

/** The line's label element followed by exactly one pending mark. @param {string} li @param {string} mark */
function marked(li, mark) {
  const bare = li.replace(mark, "");
  return bare.replace(/(<(?:span|s) class="row-label">[^<]*<\/(?:span|s)>)/, `$1${mark}`);
}

/**
 * The Offline Copy of the Shopping page with the Pending Changes shown on it, so a tick at the
 * store looks like a tick at home: a pending check is struck through and its tick unchecks, a
 * pending Delete is muted, a pending hand-add is appended to Buy, a pending Clear hides the
 * Checked Off lines. Every touched line carries a small pending mark. String replacement keyed
 * on the `data-line` attribute (the line id) src/shopping/view.ts renders. Any other page comes
 * back unchanged.
 * @param {string} html
 * @param {readonly PendingChange[]} pending
 * @param {{ pendingMark: string }} texts
 */
export function overlayPendingChanges(html, pending, texts) {
  if (!html.includes('id="shopping-lists"')) return html;
  const mark = pendingMark(texts.pendingMark);
  let out = html;
  for (const entry of pending) {
    const edit = shoppingEdit(entry);
    if (!edit) continue;
    const byId = `data-line="${edit.id}"`;
    switch (edit.kind) {
      case "check":
      case "uncheck": {
        const checked = edit.kind === "check";
        out = rewriteLine(out, `<li class="row line${checked ? "" : " line-checked"}${out.includes(`line-pending" ${byId}`) ? " line-pending" : ""}" ${byId}`, (li) =>
          marked(
            li
              .replace(/^<li class="row line[^"]*"/, `<li class="row line${checked ? " line-checked" : ""} line-pending"`)
              .replaceAll(checked ? '/shopping/check"' : '/shopping/uncheck"', checked ? '/shopping/uncheck"' : '/shopping/check"')
              .replace(`aria-pressed="${!checked}"`, `aria-pressed="${checked}"`)
              .replace(checked ? /<span class="row-label">([^<]*)<\/span>/ : /<s class="row-label">([^<]*)<\/s>/, checked ? '<s class="row-label">$1</s>' : '<span class="row-label">$1</span>'),
            mark,
          ),
        );
        break;
      }
      case "delete": {
        const open = new RegExp(`<li class="row line([^"]*)" ${byId}`).exec(out);
        if (!open || open[1].includes("line-removed")) break;
        out = rewriteLine(out, open[0], (li) => marked(li.replace(open[0], `<li class="row line${open[1]} line-removed line-pending" ${byId}`), mark));
        break;
      }
      case "add": {
        const label = `${edit.quantity ? `${edit.quantity} ` : ""}${edit.name}`;
        const li = `<li class="row line line-pending"><div class="line-body"><span class="row-label">${escapeHtml(label)}</span>${mark}</div></li>`;
        const buyStart = out.indexOf('<section id="buy">');
        const buyEnd = out.indexOf("</section>", buyStart);
        const ul = out.lastIndexOf("</ul>", buyEnd);
        out = ul > buyStart ? `${out.slice(0, ul)}${li}\n${out.slice(ul)}` : `${out.slice(0, buyEnd)}<ul class="rows">\n${li}\n</ul>\n${out.slice(buyEnd)}`;
        break;
      }
      case "clear":
        out = out.replace(/<li class="row line line-checked([^"]*)"([^>]*)>/g, (tag, classes, attrs) => (attrs.includes(" hidden") ? tag : `<li class="row line line-checked${classes}"${attrs} hidden>`));
        break;
    }
  }
  return out;
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
 * Where a back link may point: the path and query of a same-origin URL or path, else home.
 * Used for a write's referrer and for the `?back=` of the worker's own pages.
 * @param {string | null | undefined} value an absolute URL or a path
 * @param {string} origin the app's origin
 */
export function backPath(value, origin) {
  if (!value) return "/";
  let url;
  try {
    url = new URL(value, origin);
  } catch {
    return "/";
  }
  return url.origin === new URL(origin).origin ? url.pathname + url.search : "/";
}

/**
 * The response the worker gives when the network failed.
 * @param {ReturnType<typeof classify>} classification
 * @param {{
 *   config: { marker: string, offlinePaths: { saved: string, requiresConnection: string }, texts: Record<string, Record<string, string>>, frames: Record<string, Record<string, string>> },
 *   lang: string,
 *   copy?: { html: string, fetchedAt: string },
 *   pending?: readonly PendingChange[],
 *   back?: string,
 *   htmx?: boolean,
 *   formatTime?: (iso: string) => string,
 * }} context `pending`: the device's Pending Changes, shown on a Shopping copy and counted in
 * every copy's banner. `htmx`: the request carried the HX-Request header. An htmx request never
 * gets a page, since a full page must never land in a fragment target: a write is sent to one of
 * the worker's own pages with HX-Redirect, anything else gets an empty 204 so htmx polling stays
 * quiet. A Shopping List edit from a plain form is answered like the server answers it, a 303
 * back to the list, where the overlay shows it; other edits get the saved page. Any other
 * passthrough request (the online signal's /health ping) gets an empty 503, which is not `ok`.
 * @returns {Response}
 */
export function offlineResponseFor(classification, context) {
  const { config, copy, pending = [], back = "/", htmx = false, formatTime = localTime } = context;
  const lang = context.lang in config.frames ? context.lang : "sv";
  const texts = config.texts[lang];
  const frames = config.frames[lang];
  const ownPage = (/** @type {string} */ frame, /** @type {string} */ text, /** @type {number} */ status) => htmlResponse(activateTab(fillFrame(frame, text, back), back), status);
  const requiresConnection = () => ownPage(frames.requiresConnection, texts.requiresConnection, 503);
  const saved = () => ownPage(frames.saved, texts.saved, 200);
  const htmxRedirect = (/** @type {string} */ path) => new Response(null, { status: 204, headers: { "HX-Redirect": `${path}?back=${encodeURIComponent(back)}` } });
  switch (classification.kind) {
    case "page": {
      if (!classification.cacheable || !copy) return requiresConnection();
      const open = pending.filter((entry) => entry.state === "pending").length;
      const count = open === 0 ? "" : ` · ${open === 1 ? texts.pendingOne : texts.pending.replaceAll("{n}", String(open))}`;
      const banner = texts.banner.replaceAll("{time}", formatTime(copy.fetchedAt)) + count;
      return htmlResponse(injectBanner(overlayPendingChanges(copy.html, pending, texts), banner, config.marker), 200);
    }
    case "online-only-write":
      return htmx ? htmxRedirect(config.offlinePaths.requiresConnection) : requiresConnection();
    case "queueable-write":
      if (htmx) return htmxRedirect(config.offlinePaths.saved);
      return classification.route.startsWith("/shopping/") ? new Response(null, { status: 303, headers: { location: back } }) : saved();
    case "offline-page":
      return classification.page === "saved" ? saved() : requiresConnection();
    case "asset":
      return new Response(null, { status: 404 });
    default:
      return new Response(null, { status: htmx ? 204 : 503 });
  }
}

/**
 * A Pending Change as the worker stores it in IndexedDB (ADR-0007).
 * @typedef {{
 *   id: string,
 *   method: "POST",
 *   url: string,
 *   body: string,
 *   contentType: string,
 *   key: string,
 *   createdAt: string,
 *   state: "pending" | "failed",
 *   reason?: string,
 * }} PendingChange
 */

/**
 * The Pending Change for a queueable form post, built before the first network attempt so that
 * attempt already carries its Idempotency-Key; stored only when the attempt fails. Its id and its
 * Idempotency-Key are two separate UUIDs.
 * @param {{ url: string, body: string, contentType: string, now: Date, uuid: () => string }} write
 * @returns {PendingChange}
 */
export function newPendingChange({ url, body, contentType, now, uuid }) {
  const id = uuid();
  const key = uuid();
  return { id, method: "POST", url, body, contentType, key, createdAt: now.toISOString(), state: "pending" };
}

/**
 * The order to replay Pending Changes in: oldest first, the given order for equal timestamps.
 * Returns a new array.
 * @template {{ createdAt: string }} T
 * @param {readonly T[]} queue
 * @returns {T[]}
 */
export function replayOrder(queue) {
  return queue.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * The fetch that replays a Pending Change. Always the stored Idempotency-Key, so the server
 * applies the change once however often it is replayed (src/offline/idempotency.ts).
 * @param {PendingChange} entry
 * @returns {{ url: string, init: RequestInit }}
 */
export function replayRequest(entry) {
  return {
    url: entry.url,
    init: {
      method: entry.method,
      headers: { "content-type": entry.contentType, "Idempotency-Key": entry.key },
      body: entry.body,
      redirect: "follow",
    },
  };
}

/**
 * The fetch for a queueable form post's first attempt: the original request (its headers, so
 * htmx still sees HX-Request, and its redirect mode, which a navigation needs) with the Pending
 * Change's body and Idempotency-Key. If the server took the post but the answer was lost, the
 * replay carries the same key and the server applies it once.
 * @param {PendingChange} entry built from `request` by newPendingChange
 * @param {Request} request
 * @returns {{ url: string, init: RequestInit }}
 */
export function firstAttemptRequest(entry, request) {
  const headers = new Headers(request.headers);
  headers.set("Idempotency-Key", entry.key);
  return {
    url: entry.url,
    init: { method: entry.method, headers, body: entry.body, redirect: request.redirect, credentials: request.credentials },
  };
}

/**
 * Reverses escapeHtml (and src/ui/layout.ts's), which is all the server's escaping does.
 * @param {string} html
 */
function unescapeHtml(html) {
  return html.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

/**
 * What a replay's response means for its Pending Change. No response at all (a network error)
 * and a server failure keep it for the next run.
 * @param {number | undefined} status undefined when the fetch got no response
 * @param {string} bodyHtml the response body, read for a refusal's notice
 * @returns {{ kind: "drop" } | { kind: "failed", reason: string } | { kind: "keep" }}
 */
export function replayOutcome(status, bodyHtml) {
  if (status === undefined) return { kind: "keep" };
  if (status < 400) return { kind: "drop" };
  if (status >= 500) return { kind: "keep" };
  const notice = /<span class="notice-text">([^<]*)<\/span>/.exec(bodyHtml);
  return { kind: "failed", reason: notice ? unescapeHtml(notice[1]) : `HTTP ${status}` };
}
