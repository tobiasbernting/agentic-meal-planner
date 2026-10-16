/**
 * Generic webhook sink (FR-13, ADR-0006). Default format "ntfy": plain-text body, one line per
 * item, `Title` header. Format "json": `{ weekStart, items }`. The optional bearer secret comes
 * from env WEBHOOK_SECRET only, never from settings.
 */
import type { FetchLike, PushResult, ShoppingListSink } from "./types.js";
import { cardName } from "./format.js";

export interface WebhookConfig {
  url: string;
  secret?: string;
  format?: "ntfy" | "json";
  fetch?: FetchLike;
}

export function createWebhookSink({ url, secret, format = "ntfy", fetch: fetchImpl }: WebhookConfig): ShoppingListSink {
  const doFetch: FetchLike = fetchImpl ?? ((u, init) => fetch(u, init));
  return {
    id: "webhook",
    async push({ weekStart, items }): Promise<PushResult> {
      const headers: Record<string, string> =
        format === "json" ? { "Content-Type": "application/json" } : { "Content-Type": "text/plain; charset=utf-8", Title: `Shopping ${weekStart}` };
      if (secret) headers.Authorization = `Bearer ${secret}`;
      const body = format === "json" ? JSON.stringify({ weekStart, items }) : items.map(cardName).join("\n");
      try {
        const res = await doFetch(url, { method: "POST", headers, body });
        if (!res.ok) return { ok: false, error: `Webhook HTTP ${res.status}` };
        return { ok: true, detail: `${items.length} items` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Webhook: ${secret ? message.replaceAll(secret, "***") : message}` };
      }
    },
  };
}
