/**
 * Marks forms that post to an online-only route (ADR-0007) so the shell can disable them while
 * offline. Pure and string-based: `page()` runs it over the body, so a feature never opts in by
 * hand and the marker follows ONLINE_ONLY_ROUTES.
 */
import { t, type Lang } from "../i18n/index.js";
import { escapeHtml } from "../ui/layout.js";
import { ONLINE_ONLY_ROUTES } from "./allowlist.js";

/** `/schools/:id/retry` as a regex over a request path; `:param` matches one segment. */
function patternRegex(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}$`);
}

const ONLINE_ONLY_PATTERNS = ONLINE_ONLY_ROUTES.map(patternRegex);

function isOnlineOnlyPath(action: string): boolean {
  const path = action.split(/[?#]/)[0]!;
  return ONLINE_ONLY_PATTERNS.some((re) => re.test(path));
}

export function markOnlineOnlyForms(body: string, lang: Lang): string {
  const hint = escapeHtml(t(lang, "offline.requiresConnection"));
  return body.replace(/<form\b[^>]*>/g, (tag) => {
    if (tag.includes("data-online-only")) return tag;
    const action = /\saction="([^"]*)"/.exec(tag)?.[1];
    if (action === undefined || !isOnlineOnlyPath(action)) return tag;
    return `${tag.slice(0, -1)} data-online-only="${hint}">`;
  });
}
