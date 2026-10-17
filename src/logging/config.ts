import { LOG_LEVELS, type LogLevel } from "./logger.js";

type EnvLike = Record<string, string | undefined>;

/** `LOG_LEVEL` when it names a known level, else `info` in production and `debug` otherwise. */
export function resolveLogLevel(env: EnvLike): LogLevel {
  const requested = env.LOG_LEVEL?.trim().toLowerCase();
  if (requested && (LOG_LEVELS as readonly string[]).includes(requested)) return requested as LogLevel;
  return env.NODE_ENV === "production" ? "info" : "debug";
}

export interface FastifyLoggerOptions {
  level: LogLevel;
  transport?: { target: string };
}

/**
 * Fastify's `logger` option: JSON lines on stdout in production (the container), pretty-printed
 * through `pino-pretty` (a devDependency) everywhere else.
 */
export function fastifyLoggerOptions(env: EnvLike): FastifyLoggerOptions {
  const level = resolveLogLevel(env);
  return env.NODE_ENV === "production" ? { level } : { level, transport: { target: "pino-pretty" } };
}
