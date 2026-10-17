# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: the two parents of a household with school-age kids. Either of them opens the app, mostly on a phone: in the kitchen, after work, or on Sunday evening when the new week's plan arrives. Both read and edit; there are no roles.

Secondary: other households that self-host their own copy (open source, MIT). Most of them are expected to have kids in Swedish schools. Contributors who write School Plugins or Shopping List sinks use the docs, not the UI.

## Product Purpose

Plans a household's dinners Monday to Sunday around what the kids already ate for school lunch, then delivers the week's shopping list to the shared Trello board. Success means nobody has to think about dinner during the week. Dinner never repeats lunch, Quick Days get quick dishes, and the shopping list is already on the board.

Two moments matter equally:

- **Sunday review**: look over the generated Weekly Plan with each day's lunch and the selection rationale, swap or regenerate, then confirm.
- **Daily glance**: the Today view answers "what's for lunch and dinner today" at a glance.

## Positioning

Built around the kids' school lunch menus: dinner is planned against what each School actually serves, scraped from its published URL. Hard rules are deterministic (lunch collisions, Quick Days, Weekend Dishes). The LLM only picks among eligible Dishes and handles extraction, and it shows its reasoning. Weekly staples like burgers are welcome; variety is a soft preference. Self-hosted, local first, and agent-agnostic: any prompt-in/JSON-out CLI works.

## Operating Context

- Weekly rhythm: a scheduled Plan Run (default Sunday 18:00) produces next week's plan. The household reviews it and confirms it, which locks it from automatic changes.
- Shopping happens off-app: the Buy section lands on Trello as one list per week. Check pantry items stay in the app.
- Runs on the home LAN in one Docker container. No auth; the household is trusted.
- Plan Runs take time and run in Phases; the household can see which Phase a run is in.
- The app must still work in degraded mode when no agent is configured.

## Capabilities and Constraints

- Manages Dishes (Favorite and Suggested), Schools, Pantry Items, and Settings. Shows the Weekly Plan, Shopping List, Today view, and Logs.
- Server-rendered HTMX UI with no client framework. Must be phone-friendly.
- Swedish and English UI. Swedish is the default and ships first. Main Category labels exist in both languages.
- Terminology follows [GLOSSARY.md](GLOSSARY.md). Use Dish, Lunch Entry, Weekly Plan, Plan Run, and so on, never the listed _Avoid_ terms.
- Product scope and non-goals: [docs/SPEC.md](docs/SPEC.md). Architecture: [docs/DESIGN.md](docs/DESIGN.md). That file is the technical design, not a visual system.

## Evidence on Hand

No screenshots, testimonials, or usage data exist. Future work must not invent them.

## Product Principles

1. **Answer the question first.** Every screen leads with what the parent opened it for: today's meals, the week, the list.
2. **Show the why.** A pick, a swap, or a skipped day carries its rationale or its notice (no lunch data, menu changed, sink failed). Never change things silently.
3. **Degrade loudly, never fail.** A missing agent, a broken scrape, or a failed sink still leaves a usable plan, and the UI says what is missing.
4. **One-handed and quick.** Phone use in the middle of the day comes first. Setup screens can be denser, but they must still work on a phone.
5. **Household language.** Plain Swedish (or English) copy, in the household's own words, never system jargon.
