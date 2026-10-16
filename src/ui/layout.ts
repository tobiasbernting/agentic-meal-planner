/**
 * Shared server-rendered page shell. Every screen renders through `page()` so the nav,
 * viewport meta and HTMX script are in one place. Keep this file free of feature logic.
 */

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
  label: string;
}

/** Navigation order. Features append their entry here (Today first, per FR-17a). */
export const NAV: NavItem[] = [{ href: "/", label: "Today" }];

export interface PageOptions {
  title: string;
  body: string;
  lang?: string;
}

export function page({ title, body, lang = "en" }: PageOptions): string {
  const nav = NAV.map((n) => `<a href="${escapeHtml(n.href)}">${escapeHtml(n.label)}</a>`).join(" ");
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} - Meal Planner</title>
    <script src="https://unpkg.com/htmx.org@2.0.4"></script>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 0 auto; padding: 1rem; }
      nav a { margin-right: 0.75rem; }
      label { display: block; margin-top: 0.5rem; }
      input, select, textarea, button { font-size: 1rem; max-width: 100%; }
    </style>
  </head>
  <body>
    <nav>${nav}</nav>
    <main>
${body}
    </main>
  </body>
</html>
`;
}
