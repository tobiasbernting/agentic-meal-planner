/**
 * Generic webhook sink (FR-13, ADR-0006). Default format "ntfy": plain-text body, one line per
 * item, `Title` header. Format "json": `{ weekStart, items }`. The optional bearer secret comes
 * from env WEBHOOK_SECRET only, never from settings. Notices (ADR-0010) go the same way: ntfy
 * gets the title header and the text as body, json gets `{ kind: "notice", title, text }`; a
 * notice with a `topic` goes to that topic, swapped in for the URL's last path segment (or to
 * the topic itself when it is a full URL).
 */
import type { FetchLike, NoticePayload, PushResult, ShoppingListSink } from "./types.js";
import { cardName } from "./format.js";

export interface WebhookConfig {
  url: string;
  secret?: string;
  format?: "ntfy" | "json";
  fetch?: FetchLike;
}

/** The webhook URL with `topic` in place of its last path segment; a full URL topic is used as is. */
export function topicUrl(url: string, topic: string): string {
  if (/^https?:\/\//.test(topic)) return topic;
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/");
    segments[segments.length - 1] = encodeURIComponent(topic);
    parsed.pathname = segments.join("/");
    return parsed.toString();
  } catch {
    return url;
  }
}

export function createWebhookSink({ url, secret, format = "ntfy", fetch: fetchImpl }: WebhookConfig): ShoppingListSink {
  const doFetch: FetchLike = fetchImpl ?? ((u, init) => fetch(u, init));
  const send = async (target: string, headers: Record<string, string>, body: string, detail: string): Promise<PushResult> => {
    if (secret) headers.Authorization = `Bearer ${secret}`;
    try {
      const res = await doFetch(target, { method: "POST", headers, body });
      if (!res.ok) return { ok: false, error: `Webhook HTTP ${res.status}` };
      return { ok: true, detail };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Webhook: ${secret ? message.replaceAll(secret, "***") : message}` };
    }
  };
  return {
    id: "webhook",
    async push({ weekStart, items }): Promise<PushResult> {
      const headers: Record<string, string> =
        format === "json" ? { "Content-Type": "application/json" } : { "Content-Type": "text/plain; charset=utf-8", Title: `Shopping ${weekStart}` };
      const body = format === "json" ? JSON.stringify({ weekStart, items }) : items.map(cardName).join("\n");
      return send(url, headers, body, `${items.length} items`);
    },
    async notify({ title, text, topic }: NoticePayload): Promise<PushResult> {
      const target = topic ? topicUrl(url, topic) : url;
      // ntfy reads the Title header as-is; non-ASCII titles must be RFC 2047 encoded.
      const headers: Record<string, string> =
        format === "json" ? { "Content-Type": "application/json" } : { "Content-Type": "text/plain; charset=utf-8", Title: `=?UTF-8?B?${Buffer.from(title, "utf8").toString("base64")}?=` };
      const body = format === "json" ? JSON.stringify({ kind: "notice", title, text }) : text;
      return send(target, headers, body, "notice");
    },
  };
}
