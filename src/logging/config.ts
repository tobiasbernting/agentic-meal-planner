import { LOG_LEVELS, type LogLevel } from "./logger.js";

type EnvLike = Record<string, string | undefined>;

/** A level pino accepts as its threshold: an emit level, or `silent` (the test suite sets it). */
export type LogThreshold = LogLevel | "silent";

/** `LOG_LEVEL` when it names a known level (or `silent`), else `info` in production and `debug` otherwise. */
export function resolveLogLevel(env: EnvLike): LogThreshold {
  const requested = env.LOG_LEVEL?.trim().toLowerCase();
  if (requested === "silent" || (requested && (LOG_LEVELS as readonly string[]).includes(requested))) return requested as LogThreshold;
  return env.NODE_ENV === "production" ? "info" : "debug";
}

/**
 * Whether stdout is pretty-printed through `pino-pretty` (a devDependency): everywhere except
 * production (the container, JSON lines). `silent` skips loading it.
 */
export function prettyStdout(env: EnvLike): boolean {
  return env.NODE_ENV !== "production" && resolveLogLevel(env) !== "silent";
}
