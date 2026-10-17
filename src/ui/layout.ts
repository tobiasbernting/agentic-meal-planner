/**
 * Shared server-rendered page shell (spec #71). Every screen renders through `page()`, which
 * owns the document head, the stylesheet, vendored HTMX and the bottom tab bar. Visual tokens
 * and component classes live in public/app.css (see `ASSET_PATHS`). Keep feature logic out.
 */
import { DEFAULT_LANG, t, type Lang, type MessageKey } from "../i18n/index.js";
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

export function page({ title, body, tab, lang = DEFAULT_LANG }: PageOptions): string {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
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
${body}
    </main>
    ${tabBar(lang, tab)}
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
