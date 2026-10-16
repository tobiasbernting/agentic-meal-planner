# Contributing

## Adding your kid's school (the most valuable contribution)

School lunch menus are published in countless formats. This project handles them in two layers (see [ADR-0004](./docs/adr/0004-school-plugins-with-llm-fallback.md)):

1. **Generic fallback** — works out of the box: the planner fetches the menu URL and asks an LLM to extract the week's lunches.
2. **School Plugin** — a small deterministic scraper for a specific site, faster and more reliable than the fallback.

If the generic fallback works for your school but is flaky, or you want it fast and free, contribute a plugin:

```ts
// src/plugins/schools/my-school.ts  (copy src/plugins/schools/example-json.ts for a complete one)
import type { SchoolPlugin } from "../../types.js";
import type { FetchPage } from "./index.js";

export function mySchool(fetchPage: FetchPage): SchoolPlugin {
  return {
    id: "my-school-se",
    claims: (url) => url.includes("my-school.se"),
    async scrape(url, weekStart /* the week's Monday, "YYYY-MM-DD" */) {
      const page = await fetchPage(url); // never call fetch() directly: tests inject fetchPage
      // parse HTML/PDF/JSON, return one entry per date (several dishes: join with "\n")
      return [{ date: "2026-10-19", rawText: "Pasta bolognese" } /* … */];
    },
  };
}
```

Then add `mySchool(fetchPage)` to the array in `src/plugins/schools/index.ts` and a colocated `my-school.test.ts` that feeds a saved page through `fetchPage` (see `example-json.test.ts`).

Rules of thumb:

- A plugin handles a *format*, not a single institution — if ten schools use the same catering platform, one plugin covers all ten.
- Return raw text as published; normalization happens downstream.
- If your school works fine with the LLM fallback, you can also just open an issue with the URL — that's a valid contribution too; someone may promote it to a plugin.

## Everything else

- The domain language lives in [GLOSSARY.md](./GLOSSARY.md) — use it in code and issues.
- Load-bearing decisions are recorded in [docs/adr/](./docs/adr/). If you want to change one, open an issue referencing the ADR rather than silently reversing it.
- The deterministic constraint engine must stay LLM-free and fully unit-tested (ADR-0001).
- License: MIT.
