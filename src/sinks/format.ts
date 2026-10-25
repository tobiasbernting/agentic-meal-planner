import type { PushedItem } from "../shopping/list.js";

/** One shopping item as a line or card title: `<qty> <unit> <name>`, absent parts skipped. */
export function cardName(item: PushedItem): string {
  return [item.quantity, item.unit, item.name].filter((part) => part !== null && part !== "").join(" ");
}
