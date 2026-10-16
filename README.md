# Agentic Meal Planner

A self-hosted, agent-driven weekly dinner planner for households with school-age kids.

It plans next week's dinners around three inputs:

1. **Your favorite dishes** — with links to their recipes, so ingredients can be looked up automatically.
2. **Your kids' school lunch menus** — scraped from the schools' published URLs, so dinner never repeats what the kids already had for lunch.
3. **Your week's constraints** — days that need a quick dinner (activities), dishes you had recently, and the pantry staples you buy anyway.

Every week, a **Planner Agent** (running programmatically, e.g. `copilot -p` on a cron schedule inside the Docker container) produces a **Weekly Plan** and a **Shopping List**. Staple ingredients (flour, milk, cream, …) are separated into a "Check pantry" section, since you usually pick those up during the week anyway.

A small web interface lets you manage favorite dishes, schools, pantry items, and quick-day settings, and view the current plan and shopping list.

## Principles

- **Local only.** One Docker image, SQLite inside, no cloud dependency. Cron runs inside the container.
- **Hybrid planning.** Deterministic code enforces hard constraints (no lunch collisions, quick days, no recent repeats); an LLM agent does the fuzzy work (matching dish names, extracting ingredients from recipe pages, picking among eligible dishes).
- **Community school plugins.** School lunch menus come in many formats. Known schools get scraper plugins; unknown URLs fall back to generic LLM extraction. Contributions of new school plugins are the point of open-sourcing this — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Status

Early design. See:

- [docs/DESIGN.md](./docs/DESIGN.md) — architecture, data model, and flows
- [GLOSSARY.md](./GLOSSARY.md) — the domain language
- [docs/adr/](./docs/adr/) — recorded design decisions (currently *proposed*, adopted by assumption in an unattended design session and awaiting owner confirmation)

## Quickstart (planned)

```sh
docker run -v meal-planner-data:/data -p 8080:8080 ghcr.io/tobiasbernting/agentic-meal-planner
```

Then open http://localhost:8080, add your schools' lunch-menu URLs and your favorite dishes.
