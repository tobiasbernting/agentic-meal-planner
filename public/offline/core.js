// The offline service worker's decisions (ADR-0007), as pure functions: no `self`, no caches,
// no IndexedDB. public/offline/worker.js is the glue that calls them; src/offline/core.test.ts
// tests them. Served at /assets/offline-core.js. `config` is `self.OFFLINE_CONFIG`, built by
// workerConfig() in src/offline/routes.ts.

/** GETs that are neither pages nor assets: streams, polls and probes the worker never answers itself. */
const PASSTHROUGH_PATHS = ["/plan-run/banner", "/logs/stream", "/health", "/sw.js"];

const MANIFEST_PATH = "/manifest.webmanifest";

/**
 * Whether a path matches a Fastify route pattern: same segment count, `:param` matches any one
 * segment, everything else exactly.
 * @param {string} pattern
 * @param {string} path
 */
function matchesRoute(pattern, path) {
  const want = pattern.split("/");
  const have = path.split("/");
  return want.length === have.length && want.every((part, i) => part.startsWith(":") ? have[i] !== "" : part === have[i]);
}

/**
 * @param {readonly string[]} patterns
 * @param {string} path
 * @returns {string | undefined} the first pattern the path matches
 */
function findRoute(patterns, path) {
  return patterns.find((pattern) => matchesRoute(pattern, path));
}

/**
 * What the worker should do with a request.
 * @param {Request} request
 * @param {{ queueable: string[], onlineOnly: string[], pages: string[] }} config
 * @returns {{ kind: "asset" } | { kind: "page", cacheable: boolean } | { kind: "queueable-write" | "online-only-write", route: string } | { kind: "passthrough" }}
 */
export function classify(request, config) {
  const path = new URL(request.url).pathname;
  if (request.method === "POST") {
    const queueable = findRoute(config.queueable, path);
    if (queueable) return { kind: "queueable-write", route: queueable };
    const onlineOnly = findRoute(config.onlineOnly, path);
    if (onlineOnly) return { kind: "online-only-write", route: onlineOnly };
    return { kind: "passthrough" };
  }
  if (request.method !== "GET") return { kind: "passthrough" };
  if (path.startsWith("/assets/") || path === MANIFEST_PATH) return { kind: "asset" };
  if (request.headers.has("HX-Request") || PASSTHROUGH_PATHS.includes(path)) return { kind: "passthrough" };
  return { kind: "page", cacheable: findRoute(config.pages, path) !== undefined };
}
