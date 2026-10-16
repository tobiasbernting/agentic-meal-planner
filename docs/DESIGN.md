# Design

This document is the output of an unattended design session. Every decision below marked **(assumed)** was adopted from the recommended answer to a design question and is **pending owner confirmation**. The vocabulary used here is defined in [GLOSSARY.md](../GLOSSARY.md); the why behind load-bearing decisions lives in [docs/adr/](./adr/).

## Assumptions log (pending confirmation)

| # | Decision | Adopted answer |
|---|----------|----------------|
| Q1 | Tech stack | TypeScript end-to-end: Node + Fastify, better-sqlite3, server-rendered HTMX UI. One process, one image. **(confirmed 2026-10-16 — HTMX explicitly)** |
| Q2 | Planner shape | Hybrid: deterministic constraint engine + LLM selection. See ADR-0001. **(confirmed 2026-10-16)** |
| Q3 | Ingredient source | Three sources, by precedence: manual Ingredients (kid-adapted dishes), recipe URL (LLM extracts), or neither — the LLM finds a recipe from the dish name. Free-text Adaptations ("no chili — kids") modify whatever the source yields. See ADR-0003. **(confirmed 2026-10-16, amended)** |
| Q4 | Lunch ingestion | School Plugins + generic LLM fallback; multiple schools. See ADR-0004. **(confirmed 2026-10-16)** |
| Q5 | Collision rule | Block on exact dish-name match AND on same Main Category; category check configurable, default ON. **(confirmed 2026-10-16)** |
| Q6 | Staples | User-managed Pantry Items; matched Ingredients go to "Check pantry". **(confirmed 2026-10-16)** |
| Q7 | Quick Days | Recurring weekly template (e.g. Tue/Thu) with per-week override in the UI; Dish carries an optional max-prep-time tag. **(confirmed 2026-10-16)** |
| Q8 | Delivery | Web UI plus push of the Shopping List's "Buy" section via composable sinks: generic webhook (ntfy default), Bring!, Home Assistant (ADR-0006). HA is reached over the LAN — no internet exposure needed; it fans out outbound. Generation day/time configurable (default Sunday 18:00, plans the coming Mon–Sun week); manual "regenerate" button. **(confirmed 2026-10-16, amended)** |

Round-2 resolutions:

- **Auth**: none in v1. The app binds to the local network; the owner is trusted. Optional shared-secret env var later if exposed beyond LAN. **(confirmed 2026-10-16)**
- **Scheduling**: in-process scheduler (node-cron) in the same container; no external cron needed. **(confirmed 2026-10-16)**
- **Single household**: one household per deployment. No users, no tenancy. **(confirmed 2026-10-16)**
- **Holidays / no lunch data**: if a School yields no Lunch Entries for a week (holiday, scrape failure), the collision constraint simply doesn't apply for those days; the plan shows a "no lunch data" notice in the UI rather than failing. **(confirmed 2026-10-16)**
- **Variety is a soft preference, never a hard rule**: households have weekly staples ("we eat burgers every week"). Recently-planned Dishes within a configurable window (default 3 weeks) are passed to the selection step as a soft preference; repeating is allowed, with rationale. **(confirmed 2026-10-16, amended — was a hard no-repeat rule)**
- **Week definition**: Monday–Sunday, generated the preceding configured day (default Sunday 18:00). **(confirmed 2026-10-16)**
- **License**: MIT. **(confirmed 2026-10-16)**

## Architecture

```
┌───────────────────────── Docker container ─────────────────────────┐
│  Node process                                                      │
│                                                                    │
│  ┌────────────┐   ┌──────────────────┐   ┌──────────────────────┐  │
│  │ HTMX web UI│──▶│ HTTP API (Fastify)│──▶│ Domain services      │  │
│  └────────────┘   └──────────────────┘   │  - dishes, schools,  │  │
│                                          │    pantry, settings  │  │
│  ┌────────────┐   ┌──────────────────┐   │  - planner (below)   │  │
│  │ node-cron  │──▶│ Planner pipeline  │──▶│                      │  │
│  └────────────┘   └──────────────────┘   └─────────┬────────────┘  │
│                                                    │               │
│                          ┌─────────────────────────▼────────────┐  │
│                          │ SQLite (/data volume)                │  │
│                          └──────────────────────────────────────┘  │
│                                                                    │
│  Planner pipeline internals:                                       │
│   1. Lunch ingest   — School Plugins or LLM fallback (ADR-0004)    │
│   2. Constraints    — deterministic filter (ADR-0001)              │
│   3. Selection      — LlmAgent.selectDishes (ADR-0005)             │
│   4. Ingredients    — fetch recipe URLs, LlmAgent.extractIngredients│
│   5. Shopping list  — aggregate, split Pantry Items out (Q6)       │
│   6. Push           — "Buy" section → configured sinks (ADR-0006)  │
└────────────────────────────────────────────────────────────────────┘
```

## Data model (SQLite)

- **dish** — id, name, recipe_url?, adaptation_notes?, max_prep_time_minutes?, main_category?
- **dish_ingredient** — dish_id, name, quantity?, unit? (manual entries for dishes without a URL)
- **school** — id, name, url, plugin_id? (null → LLM fallback), active
- **lunch_entry** — school_id, date, raw_text, normalized_name?, fetched_at (unique on school_id+date)
- **weekly_plan** — id, week_start (Monday), generated_at, status (generated | confirmed)
- **planned_dinner** — plan_id, date, dish_id, is_quick_day, lunch_that_day?, selection_rationale?
- **pantry_item** — id, name, aliases (comma-separated for fuzzy matching)
- **shopping_list_item** — plan_id, name, quantity?, unit?, section (`buy` | `check_pantry`), source_dish_id
- **settings** — key/value: variety_window_weeks (soft preference, default 3), category_collision_enabled, quick_day_template (JSON, e.g. `{"tue":30,"thu":30}`), cron_expression (controls which day/time the plan is generated), default_prep_limit_minutes, agent_command (the agent CLI used for LLM work — ADR-0005; default `copilot -p`, e.g. `claude -p`, `codex exec`, `opencode run`), shopping_list_sinks (JSON array of sink configs; Bring!/HA credentials come from env vars, never this table)

## Key interfaces

```ts
interface SchoolPlugin {
  id: string;                    // e.g. "skolmaten-se"
  claims(url: string): boolean;  // does this plugin handle this URL?
  scrape(url: string, weekStart: Date): Promise<LunchEntry[]>;
}

interface LlmAgent {
  extractLunchMenu(pageContent: string, weekStart: Date): Promise<LunchEntry[]>;
  extractIngredients(recipePageContent: string): Promise<Ingredient[]>;
  selectDishes(input: {
    days: { date: Date; isQuickDay: boolean; lunch: LunchEntry[] }[];
    candidates: Dish[][];        // pre-filtered by the deterministic engine
    recentlyPlanned: { dishId: string; lastDate: Date }[];  // soft variety preference
  }): Promise<{ date: Date; dishId: string; rationale: string }[]>;
}
```

Both interfaces ship with one production implementation in v1 (a plugins directory + a subprocess wrapper around the configured `agent_command`), plus deterministic fallbacks. `LlmAgent` additionally has a `findRecipe(dishName: string): Promise<{ url: string; ingredients: Ingredient[] }>` method used when a Dish has neither URL nor manual Ingredients (Q3).

## Flows

**Weekly planning (cron, Sunday 18:00 default)**
1. For the coming Mon–Sun: for each active School, scrape Lunch Entries (plugin if `claims(url)`, else fetch page → `extractLunchMenu`). Cache per school+date.
2. Build per-day constraint sets: lunch dish names + Main Categories; Quick Day prep limits from the template with this week's overrides.
3. Deterministic filter: eligible Favorite Dishes per day (no name/category collision, prep-time OK). Variety is *not* enforced here.
4. `selectDishes` over the eligible sets, with recently-planned history (soft variety preference) → Weekly Plan + Planned Dinners (with rationale for transparency — including when a recent dish is repeated on purpose).
5. Resolve Ingredients per planned Dish, by precedence: manual Ingredients → recipe URL (fetch → `extractIngredients`, cached per URL + content hash) → the LLM finds a recipe from the dish name and extracts from that. Adaptations ("no chili — kids") are applied by the LLM during extraction, so the list reflects what you actually cook.
6. Aggregate into Shopping List; anything fuzzy-matching a Pantry Item (name or alias) goes to "Check pantry".
7. Push the "Buy" section to every configured shopping-list sink (webhook/ntfy, Bring!, Home Assistant — ADR-0006); "Check pantry" stays in the app. Sink failures degrade gracefully and surface in the UI.

**Regenerate** — same pipeline on demand from the UI; replaces the current plan for that week.

**Add a favorite dish** — UI form: name + optional recipe URL, manual Ingredients, and/or Adaptation notes + optional prep time + Main Category. All of URL/Ingredients/neither are valid; if neither is given, the LLM finds a recipe at plan time. That's the whole UX; friction here kills the product.

## Open questions parked for later rounds

- Exact fuzzy-match strategy for Pantry Items and lunch-collision names (embeddings vs LLM call vs normalization rules) — decide at implementation time behind the interfaces above.
- Whether `selectDishes` should see leftover/pantry inventory ("we have minced meat already") — v2.
- Notifications (email/webhook when the plan is ready) — v2.
- i18n of the UI (Swedish/English) — v2.
