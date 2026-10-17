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

The agent command (Settings, or the `AGENT_COMMAND` env var) defaults to `copilot -p` in the running server; set `AGENT_COMMAND=""` to run without an agent (degraded mode). "Today" and the weekly run use the server time zone (`-e TZ=Europe/Stockholm` with Docker; the image defaults to UTC) unless a time zone (IANA name) is saved in Settings.

Logs go to stdout: one JSON object per line when `NODE_ENV=production` (the container), pretty-printed through `pino-pretty` under `npm run dev`. `LOG_LEVEL` (`debug`, `info`, `warn`, `error`, or `silent`) sets verbosity; it defaults to `info` in production and `debug` otherwise. Every request, plan run and lunch ingest logs with a `runId` (the request id, or `cron-<ISO time>` for the weekly run), so `docker logs <container> | jq 'select(.runId == "req-7")'` shows one run. At startup the server logs the resolved agent command, whether its binary is on `PATH` (a `warn` when it is not), the time zone, `DATA_DIR` and the cron schedule. `GET /health` returns `{ "status": "ok", "agentBinaryFound": true, "agentCommand": "copilot -p" }`; the check is a `PATH` lookup and never calls the agent.

The same records also go to an in-memory buffer of the last 2000 (nothing on disk; lost on restart). Settings links to the Logs page (`/logs`), which replays that buffer and then streams new records live from `GET /logs/stream` (Server-Sent Events, one JSON object per event, the same shape as the stdout JSON). Filter by minimum level, free text, or by clicking a record's run or component. The level selector there (`POST /logs/level`, `debug`/`info`/`warn`/`error`) changes the live level in memory, so you can switch to `debug`, generate a plan, read the prompts and raw agent output, and switch back; a restart restores `LOG_LEVEL`. `curl -N http://localhost:8080/logs/stream` follows the stream from a shell; add `?once=1` to get the buffer and stop.

## Agent CLI in the container

The image installs no agent CLI, so out of the box every Weekly Plan is degraded (see [ADR-0005](./docs/adr/0005-llm-via-cli-agent-subprocess.md)). You provide the agent and its authentication. The container runs as uid 1000 (`node`) with `HOME=/home/node`.

**a) Mount a binary and its auth directory.** The binary must run inside the image (Debian bookworm, glibc, Node 24) and sit in a directory on `PATH`, or `AGENT_COMMAND` must use its absolute path:

```sh
docker run -v meal-planner-data:/data -p 8080:8080 \
  -v /path/to/copilot:/usr/local/bin/copilot:ro \
  -v ~/.copilot:/home/node/.copilot \
  ghcr.io/tobiasbernting/agentic-meal-planner
```

The auth/config directory must be readable (and, for token refresh, writable) by uid 1000. A CLI that authenticates from an env var can take `-e` instead of a mount.

**b) Derived image.** For example, with Copilot CLI (check the vendor's current install instructions):

```dockerfile
FROM ghcr.io/tobiasbernting/agentic-meal-planner
USER root
RUN npm i -g @github/copilot
USER node
```

Authenticate with a mount or env var as in (a).

**Command.** The default is `copilot -p`. For another CLI, set it in Settings or with `-e AGENT_COMMAND="<command>"` (the first word is the binary looked up on `PATH`).

**Confirm.** The startup log line `startup` has `agentBinaryFound: true`; if the binary is missing, a `warn` follows (`agent binary not found on PATH; plans will be degraded`). `curl localhost:8080/health` returns `"agentBinaryFound": true`. Both only check that the binary exists; they do not test authentication, so generate a plan and read the logs (the Logs page at `/logs` shows the agent call records).

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
