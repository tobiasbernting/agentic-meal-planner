/**
 * Logs page (spec #42, #47): the in-memory log buffer, replayed and then streamed live over
 * Server-Sent Events, with client-side filters and a live level switch. Unauthenticated, same
 * trust boundary as Settings.
 */
import type { FeaturePlugin } from "../app.js";
import type { BufferedRecord } from "../logging/buffer.js";

/** One SSE event per record: `data: <JSON>` and a blank line. */
export function sseEvent(record: BufferedRecord): string {
  return `data: ${JSON.stringify(record)}\n\n`;
}

export const logsRoutes: FeaturePlugin = async (app, ctx) => {
  const { buffer } = ctx.logs;

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
    req.raw.on("close", unsubscribe);
  });
};
