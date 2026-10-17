/**
 * Shared server-rendered page shell (spec #71). Every screen renders through `page()`, which
 * owns the document head, the stylesheet, vendored HTMX and the bottom tab bar. Visual tokens
 * and component classes live in public/app.css (see `ASSET_PATHS`). Keep feature logic out.
 */
import { DEFAULT_LANG, t, type Lang, type MessageKey } from "../i18n/index.js";
import { markOnlineOnlyForms } from "../offline/online-only.js";
import { ASSET_PATHS } from "./assets.js";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The four tabs. Library and admin pages (Dishes, Schools, Pantry, Settings, Logs) use "more". */
export type Tab = "today" | "plan" | "shopping" | "more";

/** Fixed tab order (Idag, Plan, Inköp, Mer); not driven by feature registration order. */
const TABS: { tab: Tab; href: string; label: MessageKey }[] = [
  { tab: "today", href: "/", label: "nav.today" },
  { tab: "plan", href: "/plan", label: "nav.plan" },
  { tab: "shopping", href: "/shopping", label: "nav.shopping" },
  { tab: "more", href: "/more", label: "nav.more" },
];

export interface PageOptions {
  title: string;
  body: string;
  /** The tab marked active in the tab bar. */
  tab: Tab;
  lang?: Lang;
}

function tabBar(lang: Lang, active: Tab): string {
  const links = TABS.map(
    (item) => `<a href="${item.href}"${item.tab === active ? ' aria-current="page"' : ""}>${escapeHtml(t(lang, item.label))}</a>`,
  ).join("");
  return `<nav class="tabbar" aria-label="${escapeHtml(t(lang, "nav.label"))}">${links}</nav>`;
}

/** Paper, the stylesheet's background token in light mode; the installed app's chrome colour. */
export const THEME_COLOR = "#fbfaf6";

export const MANIFEST_PATH = "/manifest.webmanifest";

/** Installability (ADR-0007): manifest, home-screen icon, standalone on iOS, chrome colour. */
function installLinks(): string {
  return `<link rel="manifest" href="${MANIFEST_PATH}" />
    <link rel="apple-touch-icon" href="${ASSET_PATHS.appleTouchIcon}" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="theme-color" content="${THEME_COLOR}" />`;
}

/** Registers the offline service worker (served by src/offline/routes.ts) where the browser has one. */
function workerRegistration(): string {
  return `<script>if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { type: "module" });</script>`;
}

/** The worker replaces this exact text with the Offline Copy banner; it must appear once per page. */
function offlineBannerMarker(): string {
  return `<div id="offline-banner"></div>`;
}

/** JSON for an inline script element: `<` is escaped so text can never close the element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The Pending Changes badge (#108), hidden until the worker reports a queue, plus its texts. */
function pendingChangesBadge(lang: Lang): string {
  const texts = {
    pending: t(lang, "offline.pending"),
    pendingOne: t(lang, "offline.pendingOne"),
    failed: t(lang, "offline.failed"),
    pendingState: t(lang, "offline.pendingState"),
    discard: t(lang, "offline.discard"),
    replayNextOpen: t(lang, "offline.replayNextOpen"),
    replayBackground: t(lang, "offline.replayBackground"),
  };
  return `<div id="pending-changes" hidden data-lang="${escapeHtml(lang)}"><button type="button" class="quiet" id="pending-changes-toggle"></button><ul class="rows" id="pending-changes-list" hidden></ul><p class="muted" id="pending-changes-note"></p></div>
<script type="application/json" id="offline-texts">${scriptJson(texts)}</script>`;
}

/**
 * The badge's glue: asks the worker for the queue (with the page language, so each entry comes
 * back labelled) on load and whenever the worker says it changed, and renders it with
 * textContent only. Discard tells the worker, which broadcasts the change.
 */
function pendingChangesScript(): string {
  return `<script>(function () {
  if (!("serviceWorker" in navigator)) return;
  var box = document.getElementById("pending-changes");
  var toggle = document.getElementById("pending-changes-toggle");
  var list = document.getElementById("pending-changes-list");
  var note = document.getElementById("pending-changes-note");
  var texts = JSON.parse(document.getElementById("offline-texts").textContent);
  var lang = box.dataset.lang;
  function fill(template, values) {
    return template.replace(/\\{(\\w+)\\}/g, function (whole, name) { return name in values ? String(values[name]) : whole; });
  }
  function time(iso) {
    return new Date(iso).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  }
  function row(entry, worker) {
    var li = document.createElement("li");
    li.className = "row with-actions";
    var label = document.createElement("p");
    label.textContent = entry.label + " " + time(entry.createdAt);
    var state = document.createElement("p");
    if (entry.state === "failed") {
      state.className = "notice";
      state.textContent = fill(texts.failed, { reason: entry.reason || "" });
    } else {
      state.className = "muted";
      state.textContent = texts.pendingState;
    }
    var discard = document.createElement("button");
    discard.type = "button";
    discard.className = "quiet";
    discard.textContent = texts.discard;
    discard.addEventListener("click", function () { worker.postMessage({ type: "discard", id: entry.id }); });
    li.append(label, state, discard);
    return li;
  }
  function render(entries, worker, background) {
    box.hidden = entries.length === 0;
    if (entries.length === 0) list.hidden = true;
    toggle.textContent = entries.length === 1 ? texts.pendingOne : fill(texts.pending, { n: entries.length });
    toggle.setAttribute("aria-expanded", String(!list.hidden));
    list.replaceChildren.apply(list, entries.map(function (entry) { return row(entry, worker); }));
    note.textContent = background ? texts.replayBackground : texts.replayNextOpen;
  }
  function refresh() {
    navigator.serviceWorker.ready.then(function (registration) {
      var worker = navigator.serviceWorker.controller || registration.active;
      if (!worker) return;
      var channel = new MessageChannel();
      channel.port1.onmessage = function (event) { render(event.data.entries, worker, "sync" in registration); };
      worker.postMessage({ type: "queue", lang: lang }, [channel.port2]);
    });
  }
  toggle.addEventListener("click", function () {
    list.hidden = !list.hidden;
    toggle.setAttribute("aria-expanded", String(!list.hidden));
  });
  navigator.serviceWorker.addEventListener("message", function (event) {
    if (event.data && event.data.type === "pending-changed") refresh();
  });
  refresh();
})();</script>`;
}

/**
 * The online signal (ADR-0007): the app is online when a request succeeds, not by the browser's
 * flag. Starts online unless the worker already put a banner in; the worker's connectivity
 * messages flip it; offline it pings /health every 10 s. Offline, online-only buttons are
 * disabled and htmx requests (the Plan Run banner polling) are cancelled. Back online, it asks
 * the worker to replay Pending Changes. Rendered at the end of body so the banner exists.
 */
function onlineSignalScript(): string {
  return `<script>(function () {
  var root = document.documentElement;
  var banner = document.getElementById("offline-banner");
  var online = !(banner && banner.children.length > 0);
  var timer = null;
  function apply() {
    root.dataset.online = online ? "1" : "0";
    var controls = document.querySelectorAll("form[data-online-only] button, form[data-online-only] input[type=submit]");
    for (var i = 0; i < controls.length; i++) controls[i].disabled = !online;
  }
  function ping() {
    fetch("/health", { cache: "no-store" }).then(function (res) { if (res.ok) set(true); }, function () {});
  }
  function set(next) {
    if (next === online) return;
    var wasOffline = !online;
    online = next;
    apply();
    if (online) {
      clearInterval(timer);
      timer = null;
      var controller = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (wasOffline && controller) controller.postMessage({ type: "replay" });
    } else if (!timer) {
      timer = setInterval(ping, 10000);
    }
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", function (event) {
      if (event.data && event.data.type === "connectivity") set(Boolean(event.data.online));
    });
  }
  document.addEventListener("htmx:beforeRequest", function (event) { if (!online) event.preventDefault(); });
  apply();
  if (!online) timer = setInterval(ping, 10000);
})();</script>`;
}

export function page({ title, body, tab, lang = DEFAULT_LANG }: PageOptions): string {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}" data-online="1">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(title)} - ${escapeHtml(t(lang, "app.name"))}</title>
    <link rel="preload" href="${ASSET_PATHS.fontRegular}" as="font" type="font/woff2" crossorigin />
    <link rel="stylesheet" href="${ASSET_PATHS.stylesheet}" />
    <script src="${ASSET_PATHS.htmx}" defer></script>
    <script src="${ASSET_PATHS.pending}" defer></script>
    ${installLinks()}
    ${workerRegistration()}
  </head>
  <body data-working-label="${escapeHtml(t(lang, "common.working"))}">
    <main class="page">
${offlineBannerMarker()}
${pendingChangesBadge(lang)}
${markOnlineOnlyForms(body, lang)}
    </main>
    ${tabBar(lang, tab)}
    ${pendingChangesScript()}
    ${onlineSignalScript()}
  </body>
</html>
`;
}

export interface NoticeOptions {
  /** Short label set in bold before the text ("Misslyckades"). Optional. */
  label?: string;
  /** Plain text, HTML-escaped here. */
  text: string;
  /** `alert` for failures that need attention now; `status` for warnings and in-flight state. */
  role?: "alert" | "status";
  /** Extra HTML appended inside the block (a retry button, a link). Not escaped. */
  actionsHtml?: string;
}

/**
 * The inverted-ink notice block for failures and warnings (failed sink or Plan Run, no lunch
 * data, degraded reasons). Red is reserved for red days; never use it for errors.
 */
export function notice({ label, text, role = "alert", actionsHtml = "" }: NoticeOptions): string {
  const head = label ? `<strong class="notice-label">${escapeHtml(label)}</strong> ` : "";
  return `<div class="notice" role="${role}">${head}<span class="notice-text">${escapeHtml(text)}</span>${actionsHtml}</div>`;
}
