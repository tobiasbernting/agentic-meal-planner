/**
 * Logs page (spec #42, #47): the in-memory log buffer, replayed and then streamed live over
 * Server-Sent Events, with client-side filters and a live level switch. Unauthenticated, same
 * trust boundary as Settings.
 */
import type { FeaturePlugin } from "../app.js";
import type { BufferedRecord } from "../logging/buffer.js";
import { LOG_LEVELS, type LogLevel } from "../logging/logger.js";

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** One SSE event per record: `data: <JSON>` and a blank line. */
export function sseEvent(record: BufferedRecord): string {
  return `data: ${JSON.stringify(record)}\n\n`;
}

export const logsRoutes: FeaturePlugin = async (app, ctx) => {
  const { buffer } = ctx.logs;
  // Live streams never end on their own; end them before shutdown so `app.close()` does not wait.
  const open = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const end of open) end();
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
    const unsubscribe = buffer.subscribe((record) => res.write(sseEvent(record)));
    const end = () => {
      unsubscribe();
      open.delete(end);
      res.end();
    };
    open.add(end);
    req.raw.on("close", end);
  });

  /** Sets the live level (debug/info/warn/error), in memory only: a restart restores LOG_LEVEL. */
  app.post<{ Body: { level?: string } }>("/logs/level", async (req, reply) => {
    const level = req.body?.level;
    if (!isLogLevel(level)) return reply.code(400).send(`level must be one of ${LOG_LEVELS.join(", ")}`);
    ctx.logs.setLevel(level);
    return reply.redirect("/logs", 303);
  });
};
