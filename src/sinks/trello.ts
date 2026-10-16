/**
 * Trello sink (FR-13, ADR-0006): each week's Buy list becomes a NEW list on the board named
 * `Shopping <Monday YYYY-MM-DD>`, with one card per item named `<qty> <unit> <name>`.
 * One-way: the board is never read back. Pushing twice creates two lists (no dedupe).
 * Credentials come from env only (TRELLO_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID).
 */
import type { Env, FetchLike, PushResult, ShoppingListSink } from "./types.js";
import type { AggregatedItem } from "../shopping/aggregate.js";

const API = "https://api.trello.com/1";

export interface TrelloConfig {
  key: string;
  token: string;
  boardId: string;
  fetch?: FetchLike;
}

export function cardName(item: AggregatedItem): string {
  return [item.quantity, item.unit, item.name].filter((part) => part !== null && part !== "").join(" ");
}

export function listName(weekStart: string): string {
  return `Shopping ${weekStart}`;
}

export function createTrelloSink({ key, token, boardId, fetch: fetchImpl }: TrelloConfig): ShoppingListSink {
  const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init));
  const auth = `key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;

  async function post(path: string, params: Record<string, string>): Promise<{ id?: string }> {
    const query = new URLSearchParams(params).toString();
    const res = await doFetch(`${API}${path}?${query}&${auth}`, { method: "POST" });
    if (!res.ok) throw new Error(`Trello HTTP ${res.status} on POST ${path}`);
    return (await res.json()) as { id?: string };
  }

  return {
    id: "trello",
    async push({ weekStart, items }): Promise<PushResult> {
      try {
        const list = await post(`/boards/${encodeURIComponent(boardId)}/lists`, { name: listName(weekStart), pos: "bottom" });
        if (!list.id) throw new Error("Trello returned no list id");
        for (const item of items) await post("/cards", { idList: list.id, name: cardName(item), pos: "bottom" });
        return { ok: true, detail: `${listName(weekStart)}: ${items.length} cards` };
      } catch (err) {
        return { ok: false, error: `Trello: ${err instanceof Error ? err.message.replaceAll(token, "***").replaceAll(key, "***") : String(err)}` };
      }
    },
  };
}

/** The Trello sink from env, or null when any of the three variables is unset/blank. */
export function trelloSinkFromEnv(env: Env = process.env, fetchImpl?: FetchLike): ShoppingListSink | null {
  const key = env.TRELLO_KEY?.trim();
  const token = env.TRELLO_TOKEN?.trim();
  const boardId = env.TRELLO_BOARD_ID?.trim();
  if (!key || !token || !boardId) return null;
  return createTrelloSink({ key, token, boardId, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
