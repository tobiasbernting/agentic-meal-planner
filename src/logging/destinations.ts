/**
 * Log destinations (spec #42): every record goes to stdout and to the in-memory `LogBuffer`
 * behind the Logs page, in the same shape. The live level is held here, in memory only; a
 * restart restores `LOG_LEVEL`.
 */
import { multistream, pino, type Logger as PinoLogger } from "pino";
import { LogBuffer, type BufferedRecord } from "./buffer.js";
import type { LogThreshold } from "./config.js";
import { truncateFields, type LogFields, type Logger, type LogLevel } from "./logger.js";
import { withRunId } from "./run-context.js";

/** Where the stdout copy of each JSON line goes. Defaults to process.stdout; tests collect lines. */
export interface LogDestination {
  write(line: string): unknown;
}

/** The Logs page's handle on logging: the buffer, and the live level. */
export interface LogControl {
  buffer: LogBuffer;
  getLevel(): LogThreshold;
  /** Sets the live level in memory (pino's level, or the gate of an injected Logger); not persisted. */
  setLevel(level: LogLevel): void;
}

/** pino's numeric levels, which stdout and the buffer both carry. */
export const PINO_LEVELS: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50 };

/** The live threshold for an injected Logger (tests), shared by its children. */
export interface LevelGate {
  level: LogThreshold;
}

function enabled(gate: LevelGate, level: LogLevel): boolean {
  return gate.level !== "silent" && PINO_LEVELS[level] >= PINO_LEVELS[gate.level];
}

/** A stream that JSON-parses each pino line into the buffer. */
function bufferStream(buffer: LogBuffer): LogDestination {
  return { write: (line: string) => buffer.push(JSON.parse(line) as BufferedRecord) };
}

/**
 * The app's pino instance, writing every line to `stdout` (pretty-printed when `pretty`) and,
 * as raw JSON, to `buffer`.
 */
export async function createPino(options: { level: LogThreshold; buffer: LogBuffer; destination?: LogDestination; pretty: boolean }): Promise<PinoLogger> {
  let stdout: LogDestination = options.destination ?? process.stdout;
  if (!options.destination && options.pretty) {
    // pino-pretty is a devDependency: only imported outside production.
    const { default: pretty } = await import("pino-pretty");
    stdout = pretty({ colorize: true });
  }
  // Each stream accepts everything from debug up; the logger's own level is the filter.
  return pino({ level: options.level }, multistream([
    { level: "debug", stream: stdout },
    { level: "debug", stream: bufferStream(options.buffer) },
  ]));
}

/** Errors as pino serialises them, so the buffer copy of an injected logger's record is JSON-safe. */
function serialisable(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? { type: value.name, message: value.message, stack: value.stack } : value;
  }
  return out;
}

/**
 * Wraps an injected Logger (tests): records at or above the gate's level go to `inner` and,
 * in pino's shape (`level` numeric, `time`), to `buffer`.
 */
export function teeLogger(inner: Logger, buffer: LogBuffer, gate: LevelGate, bindings: LogFields = {}): Logger {
  const at = (level: LogLevel) => (fields: LogFields, msg: string) => {
    if (!enabled(gate, level)) return;
    inner[level](fields, msg);
    buffer.push({ level: PINO_LEVELS[level], time: Date.now(), ...serialisable(withRunId({ ...bindings, ...truncateFields(fields) })), msg });
  };
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (more) => teeLogger(inner.child(more), buffer, gate, { ...bindings, ...truncateFields(more) }),
  };
}
