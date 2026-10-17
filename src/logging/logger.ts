/**
 * The narrow logging seam (spec #42). Modules depend on `Logger`, never on pino: the server
 * wraps Fastify's pino instance with `pinoLogger`, tests inject `createCapturingLogger()`.
 * Every emit truncates string fields over 8 KB first.
 */

import { withRunId } from "./run-context.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(fields: LogFields, msg: string): void;
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
  /** A logger whose records all carry `bindings` (e.g. `{ runId, component }`). */
  child(bindings: LogFields): Logger;
}

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export const MAX_FIELD_CHARS = 8192;

/** How deep truncation descends into nested objects and arrays; deeper values pass as-is (cycles stop here). */
const MAX_TRUNCATE_DEPTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function truncateValue(value: unknown, max: number, depth: number): unknown {
  if (typeof value === "string") return value.length <= max ? value : `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
  if (depth >= MAX_TRUNCATE_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => truncateValue(v, max, depth + 1));
  if (isPlainObject(value)) return truncateObject(value, max, depth + 1);
  return value;
}

function truncateObject(fields: LogFields, max: number, depth: number): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) out[key] = truncateValue(value, max, depth);
  return out;
}

/**
 * Strings longer than `max` chars are cut with a `…[truncated N chars]` suffix, through plain
 * objects and arrays down to a bounded depth. Errors and other class instances are untouched.
 */
export function truncateFields(fields: LogFields, max = MAX_FIELD_CHARS): LogFields {
  return truncateObject(fields, max, 0);
}

/** The slice of a pino logger this adapter uses (Fastify's `app.log` fits). */
export interface PinoLike {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  child(bindings: Record<string, unknown>): PinoLike;
}

/**
 * Wraps a pino instance as a `Logger`; fields are truncated before pino sees them. Records
 * without a bound or given `runId` get the current run's (see run-context.ts).
 */
export function pinoLogger(pino: PinoLike, runIdBound = false): Logger {
  const fieldsOf = (fields: LogFields) => truncateFields(runIdBound ? fields : withRunId(fields));
  return {
    debug: (fields, msg) => pino.debug(fieldsOf(fields), msg),
    info: (fields, msg) => pino.info(fieldsOf(fields), msg),
    warn: (fields, msg) => pino.warn(fieldsOf(fields), msg),
    error: (fields, msg) => pino.error(fieldsOf(fields), msg),
    child: (bindings) => pinoLogger(pino.child(truncateFields(bindings)), runIdBound || bindings.runId !== undefined),
  };
}

function bindingLogger(emit: (level: LogLevel, fields: LogFields, msg: string) => void, bindings: LogFields = {}): Logger {
  const at = (level: LogLevel) => (fields: LogFields, msg: string) => emit(level, withRunId({ ...bindings, ...truncateFields(fields) }), msg);
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (more) => bindingLogger(emit, { ...bindings, ...truncateFields(more) }),
  };
}

/**
 * The logger for one HTTP-triggered run: binds `runId` to Fastify's request id and the
 * `component` doing the work. Pass the result down as `log` in the run's deps.
 */
export function runLogger(log: Logger, req: { id: string }, component: string): Logger {
  return log.child({ runId: req.id, component });
}

/** Drops everything. The default where a module's deps omit `log`. */
export const silentLogger: Logger = bindingLogger(() => {});

/** Writes `level msg {fields}` to the console; a fallback for code running without the app logger. */
export const consoleLogger: Logger = bindingLogger((level, fields, msg) => {
  const line = Object.keys(fields).length ? [msg, fields] : [msg];
  console[level](...line);
});

/** One emitted record: level, message, and the fields with all child bindings merged in. */
export type LogRecord = { level: LogLevel; msg: string } & LogFields;

/**
 * A logger that stores records in memory, for tests: `buildApp({ dataDir, logger })`, then
 * assert on `records` (e.g. `records.filter((r) => r.runId === id)`). Error objects in fields
 * are kept as-is.
 */
export function createCapturingLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger = bindingLogger((level, fields, msg) => void records.push({ level, msg, ...fields }));
  return { logger, records };
}
