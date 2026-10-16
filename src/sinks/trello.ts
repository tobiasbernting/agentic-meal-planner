/**
 * Trello sink (FR-13, ADR-0006): each week's Buy list becomes a list on the board named
 * `Shopping <Monday YYYY-MM-DD>`, with one card per item named `<qty> <unit> <name>`.
 * Pushing the same week again reuses its open list (cards archived first): one list per week.
 * Only the board's open list names are read, never cards.
 * Credentials come from env only (TRELLO_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID).
 */
import type { Env, FetchLike, PushResult, ShoppingListSink } from "./types.js";
import { cardName } from "./format.js";

const API = "https://api.trello.com/1";

export interface TrelloConfig {
  key: string;
  token: string;
  boardId: string;
  fetch?: FetchLike;
}

export function listName(weekStart: string): string {
  return `Shopping ${weekStart}`;
}

export function createTrelloSink({ key, token, boardId, fetch: fetchImpl }: TrelloConfig): ShoppingListSink {
  const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init));
  const auth = `key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;

  async function get(path: string, params: Record<string, string>): Promise<unknown> {
    const query = new URLSearchParams(params).toString();
    const res = await doFetch(`${API}${path}?${query}&${auth}`, { method: "GET" });
    if (!res.ok) throw new Error(`Trello HTTP ${res.status} on GET ${path}`);
    return res.json();
  }

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
        const name = listName(weekStart);
        const open = await get(`/boards/${encodeURIComponent(boardId)}/lists`, { filter: "open" });
        const existing = Array.isArray(open) ? (open as { id?: string; name?: string }[]).find((l) => l.name === name && l.id) : undefined;
        let list: { id?: string };
        if (existing) {
          list = existing;
          await post(`/lists/${encodeURIComponent(existing.id!)}/archiveAllCards`, {});
        } else {
          list = await post(`/boards/${encodeURIComponent(boardId)}/lists`, { name, pos: "bottom" });
        }
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
