/**
 * The server's single list of what the service worker may do offline (ADR-0007). Entries are
 * Fastify route patterns (`/dishes/:id`), matched exactly. Every POST route must be in
 * QUEUEABLE_ROUTES or ONLINE_ONLY_ROUTES; src/offline/allowlist.test.ts enforces that.
 * `/sw.js` embeds these lists, so the worker never hardcodes them.
 */
import type { MessageKey } from "../i18n/index.js";

/** Write routes that may become Pending Changes, with each one's human label key. */
export const QUEUEABLE_LABELS = {
  "/dishes": "offline.label.dishCreate",
  "/dishes/:id": "offline.label.dishEdit",
  "/dishes/:id/promote": "offline.label.dishPromote",
  "/dishes/:id/delete": "offline.label.dishDelete",
  "/pantry": "offline.label.pantryCreate",
  "/pantry/:id": "offline.label.pantryEdit",
  "/pantry/:id/delete": "offline.label.pantryDelete",
  "/settings": "offline.label.settings",
  "/settings/quick-days": "offline.label.quickDays",
  "/settings/quick-days/clear": "offline.label.quickDaysClear",
  "/lang": "offline.label.lang",
  "/shopping/check": "offline.label.shoppingCheck",
  "/shopping/uncheck": "offline.label.shoppingUncheck",
  "/shopping/add": "offline.label.shoppingAdd",
  "/shopping/delete": "offline.label.shoppingDelete",
  "/shopping/clear": "offline.label.shoppingClear",
  "/shopping/pantry": "offline.label.shoppingPantry",
  "/shopping/pantry/undo": "offline.label.shoppingPantryUndo",
  "/members": "offline.label.memberCreate",
  "/members/:id": "offline.label.memberEdit",
  "/members/:id/delete": "offline.label.memberDelete",
  "/me": "offline.label.me",
  "/lists": "offline.label.listCreate",
  "/lists/:id": "offline.label.listEdit",
  "/lists/:id/move": "offline.label.listMove",
  "/lists/:id/delete": "offline.label.listDelete",
  "/lists/:id/clear": "offline.label.listClear",
  "/lists/:id/todos": "offline.label.todoCreate",
  "/todos/:id": "offline.label.todoEdit",
  "/todos/:id/tick": "offline.label.todoTick",
  "/todos/:id/untick": "offline.label.todoUntick",
  "/todos/:id/delete": "offline.label.todoDelete",
  "/todos/:id/repeat/end": "offline.label.todoRepeatEnd",
} as const satisfies Record<string, MessageKey>;

export const QUEUEABLE_ROUTES: readonly string[] = Object.keys(QUEUEABLE_LABELS);

/** Write routes that need the server (a Plan Run, an LLM, a sink or a School fetch): disabled offline. */
export const ONLINE_ONLY_ROUTES: readonly string[] = [
  "/plan/generate",
  "/plan/regenerate",
  "/plan/confirm",
  "/plan/swap",
  "/shopping/retry",
  "/shopping/push",
  "/lunch/refresh",
  "/schools",
  "/schools/:id",
  "/schools/:id/retry",
  "/schools/:id/pause",
  "/schools/:id/resume",
  "/schools/:id/delete",
  "/logs/level",
];

/** GET pages the worker keeps an Offline Copy of. */
export const OFFLINE_PAGES: readonly string[] = [
  "/",
  "/plan",
  "/shopping",
  "/dishes",
  "/dishes/new",
  "/dishes/:id/edit",
  "/dishes/:id/delete",
  "/pantry",
  "/pantry/:id/edit",
  "/members",
  "/members/:id/edit",
  "/me",
  "/lists",
  "/lists/new",
  "/lists/:id",
  "/lists/:id/edit",
  "/lists/:id/delete",
  "/lists/:id/clear",
  "/todos/:id/edit",
  "/settings/quick-days",
  "/more",
];

/** Pages fetched on every online visit; `{thisWeek}` and `{nextWeek}` are ISO Mondays the worker fills in. */
export const PREWARM_PAGES: readonly string[] = [
  "/",
  "/plan?week={thisWeek}",
  "/plan?week={nextWeek}",
  "/shopping",
  "/lists",
  "/dishes",
  "/pantry",
];

export function isQueueable(routeUrl: string): boolean {
  return QUEUEABLE_ROUTES.includes(routeUrl);
}

export function isOnlineOnly(routeUrl: string): boolean {
  return ONLINE_ONLY_ROUTES.includes(routeUrl);
}
