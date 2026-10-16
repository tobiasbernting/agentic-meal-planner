import type { AggregatedItem } from "../shopping/aggregate.js";

export type PushResult = { ok: true; detail?: string } | { ok: false; error: string };

/**
 * A place the Buy list is pushed to (FR-13, ADR-0006). `push` never throws: any failure is
 * returned as `{ ok: false, error }` so a broken sink cannot fail the plan (FR-14).
 */
export interface ShoppingListSink {
  id: string;
  push(input: { weekStart: string; items: AggregatedItem[] }): Promise<PushResult>;
}

/** Minimal fetch shape so tests can record calls without a network. */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type Env = Record<string, string | undefined>;
