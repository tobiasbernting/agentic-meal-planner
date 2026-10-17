/**
 * Server side of replaying Pending Changes (ADR-0007): a queueable POST that carries an
 * `Idempotency-Key` header is applied once. The first response for a key is stored; a repeat
 * of that key gets the stored response and the route handler never runs. Online-only routes
 * and requests without the header behave as before. Keys expire after 30 days.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../app.js";
import { isQueueable } from "./allowlist.js";

export const SCHEMA_IDEMPOTENCY = `CREATE TABLE IF NOT EXISTS idempotency_key (
  key          TEXT PRIMARY KEY,
  status       INTEGER NOT NULL,
  location     TEXT,
  content_type TEXT,
  body         TEXT,
  created_at   TEXT NOT NULL
);`;

const HEADER = "idempotency-key";

interface StoredResponse {
  status: number;
  location: string | null;
  content_type: string | null;
  body: string | null;
}

/** The key of a POST to a queueable route, else undefined. */
function keyOf(req: FastifyRequest): string | undefined {
  if (req.method !== "POST") return undefined;
  const header = req.headers[HEADER];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || !req.routeOptions.url || !isQueueable(req.routeOptions.url)) return undefined;
  return key;
}

/** Adds the hooks to `app`. Call from buildApp before the feature plugins so every route is covered. */
export function registerIdempotency(app: FastifyInstance, ctx: AppContext): void {
  const lookup = ctx.db.prepare("SELECT status, location, content_type, body FROM idempotency_key WHERE key = ?");
  const store = ctx.db.prepare(
    "INSERT OR IGNORE INTO idempotency_key (key, status, location, content_type, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  /** Requests whose response should be stored under their key. */
  const pending = new WeakMap<FastifyRequest, string>();

  app.addHook("preHandler", async (req, reply) => {
    const key = keyOf(req);
    if (!key) return;
    const hit = lookup.get(key) as StoredResponse | undefined;
    if (!hit) {
      pending.set(req, key);
      return;
    }
    reply.code(hit.status);
    if (hit.location !== null) reply.header("location", hit.location);
    if (hit.content_type !== null) reply.type(hit.content_type);
    return reply.send(hit.body ?? undefined);
  });

  app.addHook("onSend", async (req, reply, payload) => {
    const key = pending.get(req);
    if (key === undefined) return payload;
    pending.delete(req);
    const location = reply.getHeader("location");
    const contentType = reply.getHeader("content-type");
    const body = typeof payload === "string" ? payload : Buffer.isBuffer(payload) ? payload.toString("utf8") : null;
    store.run(key, reply.statusCode, location === undefined ? null : String(location), contentType === undefined ? null : String(contentType), body, ctx.now().toISOString());
    return payload;
  });
}
