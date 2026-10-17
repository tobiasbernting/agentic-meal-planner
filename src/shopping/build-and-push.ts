import { pushShoppingList, type PushDeps } from "../sinks/push.js";
import { buildShoppingList, type ShoppingListDeps } from "./build.js";

/**
 * What follows a stored Weekly Plan in every Plan Run: build its Shopping List (FR-11), then
 * push the Buy section to the sinks (FR-13). Returns how many sinks accepted the list.
 */
export async function buildAndPushShoppingList(deps: ShoppingListDeps & PushDeps, planId: number): Promise<number> {
  await buildShoppingList(deps, planId);
  return pushShoppingList(deps, planId); // never throws
}
