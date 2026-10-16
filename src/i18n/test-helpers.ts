import type { FastifyInstance } from "fastify";

/**
 * Test helper: makes every `app.inject` call default to the English UI (`lang=en` cookie),
 * for tests that assert English text. Explicit `headers.cookie` still wins.
 */
export function withEnglish<A extends FastifyInstance>(app: A): A {
  const inject = app.inject.bind(app) as (opts: Record<string, unknown>) => unknown;
  (app as { inject: unknown }).inject = (opts: Record<string, unknown>) =>
    inject({ ...opts, headers: { cookie: "lang=en", ...(opts.headers as object | undefined) } });
  return app;
}
