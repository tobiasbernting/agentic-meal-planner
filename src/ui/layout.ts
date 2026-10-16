/**
 * Shared server-rendered page shell. Every screen renders through `page()` so the nav,
 * viewport meta and HTMX script are in one place. Keep this file free of feature logic.
 */
import { DEFAULT_LANG, t, type Lang, type MessageKey } from "../i18n/index.js";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface NavItem {
  href: string;
  /** Message key of the nav label (translated per request in `page()`). */
  label: MessageKey;
}

/** Navigation order. Features append their entry here (Today first, per FR-17a). */
export const NAV: NavItem[] = [{ href: "/", label: "nav.today" }];

export interface PageOptions {
  title: string;
  body: string;
  lang?: Lang;
}

/** Language switch button; posts to /lang, which returns to the page via the Referer. */
function langButton(value: Lang, label: string, current: Lang): string {
  return `<button type="submit" name="lang" value="${value}"${value === current ? ' aria-current="true" disabled' : ""}>${label}</button>`;
}

export function page({ title, body, lang = DEFAULT_LANG }: PageOptions): string {
  const nav = NAV.map((n) => `<a href="${escapeHtml(n.href)}">${escapeHtml(t(lang, n.label))}</a>`).join(" ");
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} - ${escapeHtml(t(lang, "app.name"))}</title>
    <script src="https://unpkg.com/htmx.org@2.0.4"></script>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 0 auto; padding: 1rem; }
      .lang-switch { margin: 0.25rem 0; }
      nav a { margin-right: 0.75rem; }
      label { display: block; margin-top: 0.5rem; }
      input, select, textarea, button { font-size: 1rem; max-width: 100%; }
    </style>
  </head>
  <body>
    <nav>${nav}</nav>
    <form method="post" action="/lang" class="lang-switch">${langButton("sv", "Svenska", lang)} | ${langButton("en", "English", lang)}</form>
    <main>
${body}
    </main>
  </body>
</html>
`;
}
