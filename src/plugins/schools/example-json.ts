import { silentLogger, type Logger } from "../../logging/logger.js";
import type { LunchEntry, SchoolPlugin } from "../../types.js";
import { weekDates } from "../../week.js";

/** Fetches a menu URL and returns its body as text. Injected so plugins never touch the network in tests. */
export type FetchPage = (url: string) => Promise<string>;

/**
 * Example School Plugin (ADR-0004), the template for CONTRIBUTING.md. It handles a format,
 * not one institution: any URL ending in `.lunch.json` serving
 * `{ "days": [{ "date": "YYYY-MM-DD", "dishes": ["..."] }] }`.
 * Several dishes on one date become one Lunch Entry with the dishes joined by newline.
 */
export function exampleJsonPlugin(fetchPage: FetchPage, logger: Logger = silentLogger): SchoolPlugin {
  const log = logger.child({ component: "school-plugin" });
  return {
    id: "example-json",
    claims: (url) => url.endsWith(".lunch.json"),
    async scrape(url, weekStart) {
      const body = await fetchPage(url);
      const week = new Set(weekDates(weekStart));
      const entries: LunchEntry[] = [];
      for (const day of parseDays(body, (reason) => log.warn({ pluginId: "example-json", url, reason }, "school plugin got malformed data; returning no entries"))) {
        if (!week.has(day.date) || day.dishes.length === 0) continue;
        entries.push({ date: day.date, rawText: day.dishes.join("\n") });
      }
      return entries;
    },
  };
}

interface MenuDay {
  date: string;
  dishes: string[];
}

function parseDays(body: string, malformed: (reason: string) => void): MenuDay[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    malformed(`body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  const days = (parsed as { days?: unknown })?.days;
  if (!Array.isArray(days)) {
    malformed('expected { "days": [...] }');
    return [];
  }
  return days.flatMap((day): MenuDay[] => {
    const { date, dishes } = (day ?? {}) as { date?: unknown; dishes?: unknown };
    if (typeof date !== "string" || !Array.isArray(dishes)) return [];
    return [{ date, dishes: dishes.filter((d): d is string => typeof d === "string" && d.trim() !== "") }];
  });
}
