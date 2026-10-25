/**
 * The offline texts (ADR-0007) in one map, shared by the worker's config (src/offline/routes.ts)
 * and the shell's Pending Changes badge (src/ui/layout.ts). A module of its own so neither has to
 * import the other.
 */
import { t, type Lang, type MessageKey } from "../i18n/index.js";

/** Texts the worker and the shell's offline script show, by name. */
export const TEXT_KEYS = {
  banner: "offline.banner",
  requiresConnection: "offline.requiresConnection",
  saved: "offline.saved",
  back: "offline.back",
  unknownChange: "offline.unknownChange",
  replayNextOpen: "offline.replayNextOpen",
  replayBackground: "offline.replayBackground",
  pending: "offline.pending",
  pendingOne: "offline.pendingOne",
  failed: "offline.failed",
  pendingState: "offline.pendingState",
  discard: "offline.discard",
  /** The overlay's per-line mark on a line with a Pending Change. */
  pendingMark: "offline.pendingMark",
} as const satisfies Record<string, MessageKey>;

export type WorkerTexts = Record<keyof typeof TEXT_KEYS, string>;

/** Every offline text in one language. */
export function workerTexts(lang: Lang): WorkerTexts {
  return Object.fromEntries(Object.entries(TEXT_KEYS).map(([name, key]) => [name, t(lang, key)])) as WorkerTexts;
}
