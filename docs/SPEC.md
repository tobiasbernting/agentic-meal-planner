# Spec — v1

What we are building, for whom, and what "done" means. Domain language per [GLOSSARY.md](../GLOSSARY.md); rationale per [docs/adr/](./adr/); architecture per [DESIGN.md](./DESIGN.md). All decisions confirmed by the owner 2026-10-16.

## Purpose

A self-hosted, single-container app that plans a household's dinners Mon–Sun, working around the kids' school lunches, and delivers a shopping list to where the household actually shops. Open source (MIT) so others can contribute School Plugins and Shopping List sinks.

## Non-goals (v1)

- No auth, no users, no multi-household tenancy. Trusted LAN only.
- No breakfast/lunch/snack planning — dinners only.
- No notifications (email/push from the app itself); sinks cover delivery.
- No leftover/inventory awareness ("we have minced meat already").
- No UI internationalization.

## Functional requirements

**Dishes**
- FR-1: CRUD Favorite Dishes: name; optional recipe URL; optional manual Ingredients (name, quantity?, unit?); optional Adaptation notes; optional max-prep-time; optional Main Category.
- FR-2: A Dish with neither URL nor manual Ingredients is valid — the LLM finds a recipe at plan time.

**Schools & lunches**
- FR-3: CRUD Schools, each with one or more menu URLs. Multiple schools per household.
- FR-4: Lunch ingest per School+week: first School Plugin whose `claims(url)` matches; otherwise fetch the page and use `LlmAgent.extractLunchMenu`. Results cached per school+date.
- FR-5: If a School yields no Lunch Entries for a date (holiday, scrape failure), planning proceeds without a collision constraint for that date and the UI shows a "no lunch data" notice.

**Planning**
- FR-6: The deterministic engine filters eligible Dishes per dinner date: (a) no exact/normalized name match with that date's Lunch Entries; (b) if `category_collision_enabled` (default on), no Main Category match; (c) on Quick Days, prep time ≤ the day's limit (from the recurring template, overridable per week; fallback `default_prep_limit_minutes`).
- FR-7: `LlmAgent.selectDishes` picks among the eligible sets. Recently-planned Dishes within `variety_window_weeks` (default 3) are a **soft preference** — repeats are allowed and must carry a rationale.
- FR-8: Every Planned Dinner stores a selection rationale; plan view shows it.
- FR-9: A plan covers Monday–Sunday and is generated on a configurable schedule (`cron_expression`, default Sunday 18:00) for the *coming* week. Manual "regenerate" replaces the current week's plan.

**Ingredients & shopping list**
- FR-10: Ingredient resolution per planned Dish, by precedence: manual Ingredients → recipe URL extraction (cached per URL + content hash) → LLM-found recipe. Adaptations are applied during extraction.
- FR-11: The Shopping List aggregates all Ingredients, deduplicated, in two sections: "Buy" and "Check pantry". Anything fuzzy-matching a Pantry Item (name or alias) goes to "Check pantry".
- FR-12: CRUD Pantry Items with comma-separated aliases.

**Delivery**
- FR-13: `ShoppingListSink` interface (`push(items)`). v1 sinks, all optional and composable: generic webhook (ntfy reference default), Bring!, Home Assistant. The "Buy" section is pushed after each plan; "Check pantry" is never pushed.
- FR-14: Sink failures never fail the plan: the list stays in the app and the UI surfaces the error.

**Configuration & agent**
- FR-15: Settings editable in the UI: cron schedule, quick-day template, variety window, category-collision toggle, default prep limit, `agent_command` (default `copilot -p`; any prompt-in/JSON-out CLI works: claude, codex, opencode, …).
- FR-16: All LLM access goes through `LlmAgent` (ADR-0005). With no agent configured, the system degrades: deterministic filtering still runs, selection falls back to round-robin with rationale "no agent configured", and extraction-dependent features report themselves unavailable.

**UI**
- FR-17: Server-rendered HTMX UI: manage Dishes, Schools, Pantry Items, Settings; view current Weekly Plan (with per-day lunch context and rationale); view Shopping List; trigger regenerate. Phone-friendly.

## Non-functional requirements

- NFR-1: One Docker image, one process, SQLite on a mounted `/data` volume (ADR-0002).
- NFR-2: Local-only: binds LAN; no telemetry, no required outbound calls except menu/recipe fetches and configured sinks.
- NFR-3: The deterministic constraint engine and shopping-list aggregation are pure, LLM-free, and unit-tested (ADR-0001).
- NFR-4: LLM prompts request JSON; responses validated, retried once, then degraded (ADR-0005).
- NFR-5: License MIT; GLOSSARY/ADR conventions enforced in review (CONTRIBUTING.md).

## Acceptance criteria (v1 done)

1. `docker run` with a volume and env vars; add a school URL and five dishes; get a plan + shopping list with zero scraping code written (LLM fallback path).
2. A day whose school lunch matches a Dish's Main Category never gets that category planned.
3. A Quick Day never gets a Dish over its prep-time limit.
4. Burgers can appear every week without manual intervention.
5. Flour in a recipe lands in "Check pantry", not in "Buy"; "Buy" reaches at least one configured sink.
6. With `agent_command` unset, the app still produces a (degraded) plan.
7. A contributor can add a School Plugin by copying CONTRIBUTING.md's example, with tests.
