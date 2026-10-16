# Agentic Meal Planner

A self-hosted, agent-driven weekly dinner planner for households with school-age kids.

It plans next week's dinners around three inputs:

1. **Your favorite dishes** — with links to their recipes, so ingredients can be looked up automatically.
2. **Your kids' school lunch menus** — scraped from the schools' published URLs, so dinner never repeats what the kids already had for lunch.
3. **Your week's constraints** — days that need a quick dinner (activities), dishes you've had recently (a soft preference, not a ban), and the pantry staples you buy anyway.

Every week — on a configurable day, default Sunday evening — a **Planner Agent** (running programmatically via a configurable agent CLI such as `copilot -p`, `claude -p`, or `codex exec`, inside the Docker container on a cron schedule) produces a **Weekly Plan** and a **Shopping List**. The list's "Buy" section is pushed to your shared Trello board, one list per week (an optional webhook such as ntfy can also receive it); staple ingredients (flour, milk, cream, …) stay behind in a "Check pantry" section, since you usually pick those up during the week anyway.

A small web interface lets you manage favorite dishes, schools, pantry items, and quick-day settings, and view the current plan and shopping list.

## Principles

- **Local first.** One Docker image, SQLite inside, no database or broker to run. Cron runs inside the container. Outbound calls go only to school and recipe sites, the agent CLI you configure, and the shopping-list sinks you enable.
- **Hybrid planning.** Deterministic code enforces hard constraints (no lunch collisions, quick days); an LLM agent does the fuzzy work (matching dish names, extracting ingredients from recipe pages, picking among eligible dishes). Variety is a soft preference — weekly staples like burgers are welcome.
- **Community school plugins.** School lunch menus come in many formats. Known schools get scraper plugins; unknown URLs fall back to generic LLM extraction. Contributions of new school plugins are the point of open-sourcing this — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Status

Early design. See:

- [docs/DESIGN.md](./docs/DESIGN.md) — architecture, data model, and flows
- [docs/SPEC.md](./docs/SPEC.md) — v1 functional requirements and acceptance criteria
- [GLOSSARY.md](./GLOSSARY.md) — the domain language
- [docs/adr/](./docs/adr/) — recorded design decisions (status per ADR; all but ADR-0002 accepted by the owner on 2026-10-16)

## Quickstart (planned)

```sh
docker run -v meal-planner-data:/data -p 8080:8080 ghcr.io/tobiasbernting/agentic-meal-planner
```

Then open http://localhost:8080, add your schools' lunch-menu URLs and your favorite dishes.

## Configuration

Shopping List Sinks are set in Settings as a JSON array (empty = Trello when `TRELLO_KEY`, `TRELLO_TOKEN`, `TRELLO_BOARD_ID` are set, else no push):

```json
[{ "type": "trello" }, { "type": "webhook", "url": "https://ntfy.sh/my-topic", "format": "ntfy" }]
```

`format` is `ntfy` (default, plain text) or `json` (`{ weekStart, items }`). Only the Buy list is pushed. Secrets come from env, never settings: `WEBHOOK_SECRET` adds a bearer `Authorization` header.

## Development

Requires Node 24+.

```sh
npm ci
npm run dev          # serves on http://localhost:8080, SQLite in ./data (set DATA_DIR / PORT to override)
npm test             # vitest
npm run typecheck
```

Build and run the container locally:

```sh
docker build -t meal-planner .
docker run -v meal-planner-data:/data -p 8080:8080 meal-planner
```

The SQLite file lives at `/data/meal-planner.db` inside the container, so it survives restarts as long as the volume does. The container runs as the unprivileged `node` user (uid 1000); a named volume works out of the box, while a bind mount (`-v ./data:/data`) must be writable by that uid.
