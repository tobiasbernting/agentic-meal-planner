/**
 * Which sinks are active. The `shopping_list_sinks` setting is a JSON array of entries such
 * as `{ "type": "trello" }` (#37 adds `{ "type": "webhook", "url": ... }` via SINK_FACTORIES).
 * Empty/unset setting: Trello when its env vars are set, else none. Malformed JSON and
 * unknown types are skipped, never thrown.
 */
import type Database from "better-sqlite3";
import { readSetting } from "../db.js";
import { SETTING_SHOPPING_LIST_SINKS } from "../planner/settings.js";
import { trelloSinkFromEnv } from "./trello.js";
import type { Env, FetchLike, ShoppingListSink } from "./types.js";

export interface SinkEntry {
  type: string;
  [key: string]: unknown;
}

export type SinkFactory = (entry: SinkEntry, env: Env, fetchImpl?: FetchLike) => ShoppingListSink | null;

/** Add new sink types here (one line each). */
export const SINK_FACTORIES: Record<string, SinkFactory> = {
  trello: (_entry, env, fetchImpl) => trelloSinkFromEnv(env, fetchImpl),
};

function parseEntries(raw: string | undefined): SinkEntry[] {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is SinkEntry => typeof e === "object" && e !== null && typeof (e as SinkEntry).type === "string");
  } catch {
    return [];
  }
}

export function configuredSinks(db: Database.Database, env: Env = process.env, fetchImpl?: FetchLike): ShoppingListSink[] {
  const entries = parseEntries(readSetting(db, SETTING_SHOPPING_LIST_SINKS));
  if (entries.length === 0) {
    const trello = trelloSinkFromEnv(env, fetchImpl);
    return trello ? [trello] : [];
  }
  const sinks: ShoppingListSink[] = [];
  for (const entry of entries) {
    const sink = SINK_FACTORIES[entry.type]?.(entry, env, fetchImpl) ?? null;
    if (sink) sinks.push(sink);
  }
  return sinks;
}
