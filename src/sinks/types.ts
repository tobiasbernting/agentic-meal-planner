import type { PushedItem } from "../shopping/list.js";

export type PushResult = { ok: true; detail?: string } | { ok: false; error: string };

/**
 * A place the Buy list is pushed to (FR-13, ADR-0006). `push` never throws: any failure is
 * returned as `{ ok: false, error }` so a broken sink cannot fail the plan (FR-14).
 */
export interface ShoppingListSink {
  id: string;
  push(input: ShoppingPayload): Promise<PushResult>;
  /**
   * A short message instead of the list (ADR-0010: the Daily Brief and Due reminders). Only
   * sinks that can carry one have it; `topic` sends to that ntfy topic instead of the
   * configured one. Never throws.
   */
  notify?(notice: NoticePayload): Promise<PushResult>;
}

export interface ShoppingPayload {
  weekStart: string;
  items: PushedItem[];
}

/** The second payload shape of the webhook sink. */
export interface NoticePayload {
  kind: "notice";
  title: string;
  text: string;
  topic?: string;
}

/** Minimal fetch shape so tests can record calls without a network. */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type Env = Record<string, string | undefined>;
