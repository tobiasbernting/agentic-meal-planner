# Agentic Meal Planner

A self-hosted list app for households with school-age kids, with an agent-driven weekly dinner plan built around the school lunches. The Shopping List the plan writes, the household's other Lists and Todos, and today's lunch and dinner live in one app ([ADR-0010](./docs/adr/0010-household-lists-and-todos.md)).

It plans next week's dinners around three inputs:

1. **Your favorite dishes** — with links to their recipes, so ingredients can be looked up automatically.
2. **Your kids' school lunch menus** — scraped from the schools' published URLs, so dinner never repeats what the kids already had for lunch.
3. **Your week's constraints** — days that need a quick dinner (activities), dishes you've had recently (a soft preference, not a ban), and the pantry staples you buy anyway.

Every week — on a configurable day, default Sunday evening — a **Planner Agent** (running programmatically via a configurable agent CLI such as `copilot -p`, `claude -p`, or `codex exec`, inside the Docker container on a cron schedule) produces a **Weekly Plan** and adds what its dinners need to the household's one **Shopping List**. The list lives in the app: both parents tick it off at the store, add lines by hand, delete a line for good or clear the ticked ones when the shopping is unpacked; a Plan Run only ever adds to it ([ADR-0009](./docs/adr/0009-one-living-shopping-list-with-shares.md)). An optional webhook such as ntfy can also receive the open "Buy" lines; staple ingredients (flour, milk, cream, …) stay in a "Check pantry" section, since you usually pick those up during the week anyway.

A small web interface lets you manage favorite dishes, schools, pantry items, Members and quick-day settings, view the current plan and shopping list, and keep every other List the household writes down. Five tabs: **Idag** (today's lunch, dinner and Todos), **Inköp** (the Shopping List), **Listor** (every List), **Plan** (the week) and **Mer** (Dishes, Schools, Pantry, Members, Settings, Logs).

## Lists and todos

- **Lists.** Listor holds every List, the Shopping List first. A new List is shopping-style (lines with a free-text quantity, ticked, struck and Cleared like the Shopping List, with a "Nyligen" tray that puts a recently cleared line back with one tap) or todo-style (Todos). Every List is shared by the whole household; there are no private Lists.
- **Todos.** A Todo has a title, optional notes, an optional Due date and time, an optional Member and an optional Repeat (daily, weekdays, weekly on chosen days, every N weeks, monthly on a day, yearly). Ticking a Todo marks it Done: it stays struck below the open ones until you Clear. Ticking a repeating Todo moves it to its next Due date instead. Today shows overdue and due-today Todos under the day's lunch and dinner; each Plan day lists the Todos due that day.
- **Members without login.** Add the household's people under Mer > Members with a name and a colour. Each phone picks its Member once (Mer > "Den här telefonen"); that is a cookie, not an account. Ticks and adds are then attributed ("Pappa 14:02", and in each List's Activity), and "Mina" filters Today and a List to your Todos.
- **Quick Add.** Type one phrase at the top of a todo-style List; the parsed words are marked on the new row, and "behåll som text" keeps the phrase whole instead. The grammar follows the UI language and needs no agent:

  | | Swedish | English |
  | --- | --- | --- |
  | Day | `idag`, `imorgon`, `i övermorgon`, `fredag` / `fre` (the next one), `24/12`, `5/1-2027` | `today`, `tomorrow`, `friday`, `24/12` |
  | Time | `kl 15`, `kl 9:30`, `18:05` | `at 5pm`, `at 17:00`, `9pm` |
  | Repeat | `varje dag`, `varje vardag`, `varje måndag och torsdag`, `varannan vecka`, `varje månad den 25`, `varje år` | `every day`, `weekdays`, `every monday and wednesday`, `every other week`, `monthly on the 5th`, `yearly` |
  | Member | `@Pappa` | `@Pappa` |

  "Boka tandläkare Ella fredag kl 15 @Mamma" becomes "Boka tandläkare Ella", Due next Friday at 15:00, assigned to Mamma.
- **Daily Brief.** Settings > Meddelanden takes a time (HH:MM; empty is off). At that minute the webhook sink receives today's lunch per School, the dinner, the Todos due and overdue, and how many lines are left to buy. A Todo with a Due time also gets a message at that time, and a copy to its Member's own ntfy topic when the Member has one. Nothing is sent without a webhook sink; Settings says so.

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

## Quickstart

```sh
docker run -v meal-planner-data:/data -p 8080:8080 ghcr.io/tobiasbernting/agentic-meal-planner
```

Then open http://localhost:8080, add your schools' lunch-menu URLs and your favorite dishes.

Every push to `main` that passes typecheck and tests publishes `:latest` and `:sha-<short>` (linux/amd64). For a homelab, [deploy/](./deploy/) has a [Compose file](./deploy/compose.yaml) and an [Ansible playbook](./deploy/ansible/meal-planner.yml); both pull `:latest`, so re-running them updates the app.

### Phones away from home: a VPN to the LAN

The app is meant to stay on the LAN, never exposed to the internet. To use it at the store, give the phones a tunnel home ([ADR-0008](./docs/adr/0008-reach-via-wireguard-on-the-gateway.md)). What works for the owner's household: WireGuard hosted on the UniFi gateway (Network app > VPN Server), one peer per phone in the official WireGuard app with On-Demand enabled for everything except the home Wi-Fi, and the peer's DNS set to the LAN resolver so the app's LAN name resolves over the tunnel. The phone then reaches the app as at home, with no tap. Tailscale works the same way with less setup and also gives you HTTPS, below.

### Phones and offline: serve HTTPS on the LAN

On a phone the app is meant to be added to the home screen and to keep working at the store: it keeps an Offline Copy of Today, Plan, Shopping, Dishes and Pantry, and edits made offline are saved as Pending Changes and sent when the phone is back home ([ADR-0007](./docs/adr/0007-offline-first-service-worker-queued-writes.md)). All of that runs in a service worker, and browsers only install one on `localhost` or over HTTPS. Over plain `http://192.168.x.x:8080` a phone gets the ordinary online app and nothing offline, with no error shown.

So for phones, put HTTPS in front of the container. The container itself still speaks plain HTTP on port 8080. Two setups that work on a home LAN:

- **A reverse proxy with its own local CA.** [Caddy](https://caddyserver.com/) with `tls internal`, or any proxy with a [mkcert](https://github.com/FiloSottile/mkcert) certificate. Install the CA's root certificate on each phone once (iOS: install the profile, then enable full trust under Settings > General > About > Certificate Trust Settings; Android: Settings > Security > Install a certificate > CA certificate).
- **Tailscale.** `tailscale cert` gives the box a real certificate for its tailnet name, and phones on the tailnet reach it over HTTPS with nothing to install.

A built-in option, the container serving HTTPS with a certificate it generates itself, is tracked in [#110](https://github.com/tobiasbernting/agentic-meal-planner/issues/110). Plain HTTP over a VPN is a fine choice too: the tunnel encrypts the traffic, and you only lose the offline features.

## Configuration

Shopping List Sinks are set in Settings as a JSON array (empty = no push). The Trello sink is being removed ([ADR-0008](./docs/adr/0008-reach-via-wireguard-on-the-gateway.md)); the webhook stays:

```json
[{ "type": "webhook", "url": "https://ntfy.sh/my-topic", "format": "ntfy" }]
```

`format` is `ntfy` (default, plain text) or `json` (`{ weekStart, items }`). Only the Buy list is pushed. The same webhook carries the Daily Brief and Due messages: ntfy gets a `Title` header and the text as the body, json gets `{ "kind": "notice", "title", "text" }`. A Member's topic replaces the last path segment of the webhook URL (or, given as a full URL, is used as is). Secrets come from env, never settings: `WEBHOOK_SECRET` adds a bearer `Authorization` header.

The agent command (Settings, or the `AGENT_COMMAND` env var) defaults to `copilot --model gpt-5-mini --reasoning-effort low --allow-tool=url -p` in the running server; set `AGENT_COMMAND=""` to run without an agent (degraded mode). "Today" and the weekly run use the server time zone (`-e TZ=Europe/Stockholm` with Docker; the image defaults to UTC) unless a time zone (IANA name) is saved in Settings.

Logs go to stdout: one JSON object per line when `NODE_ENV=production` (the container), pretty-printed through `pino-pretty` under `npm run dev`. `LOG_LEVEL` (`debug`, `info`, `warn`, `error`, or `silent`) sets verbosity; it defaults to `info` in production and `debug` otherwise. Every request, plan run and lunch ingest logs with a `runId` (the request id, or `cron-<ISO time>` for the weekly run), so `docker logs <container> | jq 'select(.runId == "req-7")'` shows one run. At startup the server logs the resolved agent command, whether its binary is on `PATH` (a `warn` when it is not), the time zone, `DATA_DIR` and the cron schedule. `GET /health` returns `{ "status": "ok", "agentBinaryFound": true, "agentCommand": "copilot --model gpt-5-mini --reasoning-effort low --allow-tool=url -p" }`; the check is a `PATH` lookup and never calls the agent.

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

**Command.** The default is `copilot --model gpt-5-mini --reasoning-effort low --allow-tool=url -p`, a cheap model at low reasoning effort, since planning prompts are small JSON extraction and pick-one tasks. Commands you already saved in Settings are not changed. For another CLI, set it in Settings or with `-e AGENT_COMMAND="<command>"` (the first word is the binary looked up on `PATH`). The prompt is appended as the last argument, so a flag that takes a value, such as Copilot's `-p`, must come last. Cheap-model equivalents:

| CLI | Command |
| --- | --- |
| Copilot CLI | `copilot --model gpt-5-mini --reasoning-effort low --allow-tool=url -p` |
| Claude Code | `claude -p --model haiku` |
| Codex CLI | `codex exec --model gpt-5-mini` |

**Permission.** The Copilot default adds `--allow-tool=url`, which lets the agent use its web-fetch tool so recipe search can read pages. Copilot in `-p` mode cannot answer permission prompts, so without it every fetch is denied. Do not widen this to `--allow-all`, `--allow-all-tools` or `--yolo`: the app has no authentication and is meant for a LAN, so the agent should be able to read web pages and nothing else (no shell, no file writes).

The model names are best guesses: none of these CLIs can list models non-interactively. If the CLI's model picker shows a different cheap tier, correct the model name in Settings.

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
