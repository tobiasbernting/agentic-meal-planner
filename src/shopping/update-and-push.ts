import { pushShoppingList, type PushDeps } from "../sinks/push.js";
import { updateShoppingList, type ShoppingUpdateDeps } from "./shares.js";

/**
 * What follows a stored Weekly Plan in every Plan Run: update the Shopping List with the plan's
 * Shares (ADR-0009), then push the open Buy lines to the sinks (FR-13). Returns how many sinks
 * accepted the list.
 */
export async function updateAndPushShoppingList(deps: ShoppingUpdateDeps & PushDeps, planId: number): Promise<number> {
  await updateShoppingList(deps, planId);
  return pushShoppingList(deps, planId); // never throws
}
