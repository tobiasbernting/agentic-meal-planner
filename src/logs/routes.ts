/**
 * Logs page (spec #42, #47): the in-memory log buffer, replayed and then streamed live over
 * Server-Sent Events, with client-side filters and a live level switch. Unauthenticated, same
 * trust boundary as Settings.
 */
import type { FeaturePlugin } from "../app.js";
import { LOG_BUFFER_SIZE, type BufferedRecord } from "../logging/buffer.js";
import { isLogLevel, type LogThreshold } from "../logging/config.js";
import { PINO_LEVELS } from "../logging/destinations.js";
import { LOG_LEVELS } from "../logging/logger.js";
import { langOf, t, type Lang } from "../i18n/index.js";
import { escapeHtml, page } from "../ui/layout.js";

/** How often an idle live stream gets a `: ping` comment line. */
const HEARTBEAT_MS = 15_000;

/** One SSE event per record: `data: <JSON>` and a blank line. */
export function sseEvent(record: BufferedRecord): string {
  return `data: ${JSON.stringify(record)}\n\n`;
}

/** JSON for an inline <script>: `<` escaped so a string can never close the tag. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * The browser side: one EventSource, records rendered with textContent (never innerHTML),
 * client-side filters. Records carry pino's numeric `level`. On (re)connect the server replays
 * the whole buffer, so the list is cleared on `open`.
 */
const CLIENT_SCRIPT = `
(() => {
  const { labels, rank: RANK, max: MAX } = JSON.parse(document.getElementById("logs-config").textContent);
  const LEVELS = Object.fromEntries(Object.entries(RANK).map(([name, n]) => [n, name]));
  const list = document.getElementById("logs-list");
  const status = document.getElementById("logs-status");
  const minLevel = document.getElementById("logs-min-level");
  const search = document.getElementById("logs-search");
  const chips = { runId: document.getElementById("logs-chip-runId"), component: document.getElementById("logs-chip-component") };
  const filter = { runId: "", component: "" };

  const levelOf = (r) => (typeof r.level === "number" ? LEVELS[r.level] || String(r.level) : String(r.level));
  const matches = (row) => {
    const r = row.record;
    if ((RANK[levelOf(r)] || 0) < RANK[minLevel.value]) return false;
    if (filter.runId && r.runId !== filter.runId) return false;
    if (filter.component && r.component !== filter.component) return false;
    const q = search.value.trim().toLowerCase();
    return !q || row.text.includes(q);
  };
  const refresh = () => {
    for (const row of list.children) row.hidden = !matches(row);
  };
  const setChip = (key, value) => {
    filter[key] = value;
    const chip = chips[key];
    chip.hidden = !value;
    chip.querySelector("span").textContent = value;
    refresh();
  };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const chipButton = (key, value) => {
    const b = el("button", "logs-pick", value);
    b.type = "button";
    b.title = labels[key];
    b.addEventListener("click", () => setChip(key, value));
    return b;
  };
  const render = (r) => {
    const row = el("li", "logs-row logs-" + levelOf(r));
    row.record = r;
    row.text = JSON.stringify(r).toLowerCase();
    const time = typeof r.time === "number" ? new Date(r.time).toLocaleTimeString([], { hour12: false }) : "";
    row.append(el("span", "logs-time", time), " ", el("strong", "", levelOf(r).toUpperCase()), " ");
    if (r.component) row.append(chipButton("component", String(r.component)), " ");
    if (r.runId) row.append(chipButton("runId", String(r.runId)), " ");
    row.append(el("span", "", String(r.msg ?? "")));
    const { level, time: _t, msg, runId, component, pid, hostname, ...rest } = r;
    if (Object.keys(rest).length) row.append(" ", el("code", "", JSON.stringify(rest)));
    row.hidden = !matches(row);
    return row;
  };

  const atBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
  const source = new EventSource("/logs/stream");
  source.addEventListener("open", () => {
    list.replaceChildren();
    status.textContent = labels.live;
  });
  source.addEventListener("error", () => {
    status.textContent = labels.disconnected;
  });
  source.addEventListener("message", (event) => {
    const stick = atBottom();
    list.append(render(JSON.parse(event.data)));
    while (list.children.length > MAX) list.firstElementChild.remove();
    if (stick) window.scrollTo(0, document.body.scrollHeight);
  });

  minLevel.addEventListener("change", refresh);
  search.addEventListener("input", refresh);
  for (const key of Object.keys(chips)) chips[key].querySelector("button").addEventListener("click", () => setChip(key, ""));
})();
`;

function levelOptions(levels: readonly string[], selected: string): string {
  return levels.map((l) => `<option value="${l}"${l === selected ? " selected" : ""}>${l}</option>`).join("");
}

function chip(lang: Lang, key: "runId" | "component"): string {
  return `<p id="logs-chip-${key}" hidden>${t(lang, `logs.${key}`)}: <span></span> <button type="button">${t(lang, "logs.clearFilter")}</button></p>`;
}

function logsPage(lang: Lang, level: LogThreshold): string {
  const labels = {
    live: t(lang, "logs.live"),
    disconnected: t(lang, "logs.disconnected"),
    runId: t(lang, "logs.runId"),
    component: t(lang, "logs.component"),
  };
  const body = `<h1>${t(lang, "logs.title")}</h1>
<p>${escapeHtml(t(lang, "logs.help", { n: LOG_BUFFER_SIZE }))}</p>
<form method="post" action="/logs/level">
  <p>${escapeHtml(t(lang, "logs.currentLevel", { level }))}</p>
  <label>${t(lang, "logs.levelLabel")} <select name="level">${levelOptions(LOG_LEVELS, level)}</select></label>
  <button type="submit">${t(lang, "logs.setLevel")}</button>
</form>
<fieldset>
  <label>${t(lang, "logs.minLevel")} <select id="logs-min-level">${levelOptions(LOG_LEVELS, "debug")}</select></label>
  <label>${t(lang, "logs.search")} <input id="logs-search" type="search" /></label>
  ${chip(lang, "runId")}
  ${chip(lang, "component")}
</fieldset>
<p id="logs-status" role="status">${t(lang, "logs.connecting")}</p>
<style>
  #logs-list { list-style: none; padding: 0; font-family: ui-monospace, monospace; font-size: 0.8rem; }
  .logs-row { padding: 0.15rem 0; border-bottom: 1px solid #eee; overflow-wrap: anywhere; }
  .logs-warn { background: #fff6dd; }
  .logs-error { background: #fde7e7; }
  .logs-time { color: #666; }
  .logs-pick { font: inherit; padding: 0 0.25rem; cursor: pointer; }
</style>
<ol id="logs-list"></ol>
<script type="application/json" id="logs-config">${scriptJson({ labels, rank: PINO_LEVELS, max: LOG_BUFFER_SIZE })}</script>
<script>${CLIENT_SCRIPT}</script>`;
  return page({ title: t(lang, "logs.title"), body, lang });
}

export const logsRoutes: FeaturePlugin = async (app, ctx) => {
  const { buffer } = ctx.logs;
  // Live streams never end on their own; end them before shutdown so `app.close()` does not wait.
  const open = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const end of open) end();
  });

  app.get("/logs", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    return logsPage(langOf(req), ctx.logs.getLevel());
  });

  /**
   * Replays the buffer, then pushes each new record until the client disconnects.
   * `?once=1` ends the response after the replay (tests, and `curl` snapshots).
   */
  app.get<{ Querystring: { once?: string } }>("/logs/stream", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    for (const record of buffer.snapshot()) res.write(sseEvent(record));
    if (req.query.once) {
      res.end();
      return;
    }
    // A client that stops reading gets records dropped until its socket drains, never queued.
    let draining = false;
    const send = (chunk: string) => {
      if (draining) return;
      if (!res.write(chunk)) {
        draining = true;
        res.once("drain", () => void (draining = false));
      }
    };
    const unsubscribe = buffer.subscribe((record) => send(sseEvent(record)));
    // Keeps proxies and the browser from timing out an idle stream.
    const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(end);
      res.end();
    };
    open.add(end);
    req.raw.on("close", end);
    res.on("close", end);
    res.on("error", end);
  });

  /** Sets the live level (debug/info/warn/error), in memory only: a restart restores LOG_LEVEL. */
  app.post<{ Body: { level?: string } }>("/logs/level", async (req, reply) => {
    const level = req.body?.level;
    if (!isLogLevel(level)) return reply.code(400).send(`level must be one of ${LOG_LEVELS.join(", ")}`);
    ctx.logs.setLevel(level);
    return reply.redirect("/logs", 303);
  });
};
