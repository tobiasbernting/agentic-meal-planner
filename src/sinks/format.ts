import type { AggregatedItem } from "../shopping/aggregate.js";

/** One shopping item as a line or card title: `<qty> <unit> <name>`, absent parts skipped. */
export function cardName(item: AggregatedItem): string {
  return [item.quantity, item.unit, item.name].filter((part) => part !== null && part !== "").join(" ");
}
