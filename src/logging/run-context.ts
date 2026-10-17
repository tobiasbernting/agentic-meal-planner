/**
 * The current run's id, carried through async calls (spec #42 US-6). Loggers built once and
 * shared across runs (the `llm` child in src/app.ts) tag their records with it: every request
 * runs under its Fastify request id, every scheduler tick under `cron-<ISO>`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { LogFields } from "./logger.js";

const store = new AsyncLocalStorage<string>();

/** Runs `fn` with `runId` as the current run id, for `fn` and everything it awaits. */
export function runWithRunId<T>(runId: string, fn: () => T): T {
  return store.run(runId, fn);
}

/** The current run id, or undefined outside a run. */
export function currentRunId(): string | undefined {
  return store.getStore();
}

/** `fields` with the current run id added when it has no `runId` of its own. */
export function withRunId(fields: LogFields): LogFields {
  if (fields.runId !== undefined) return fields;
  const runId = currentRunId();
  return runId === undefined ? fields : { runId, ...fields };
}
