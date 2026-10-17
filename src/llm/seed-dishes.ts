import type { SeedDish } from "./types.js";

/** The default free-text style for Suggested Dishes (settings `suggestion_style`). */
export const DEFAULT_SUGGESTION_STYLE = "family-friendly Swedish home cooking for a household with kids";

/** Swedish family classics: inspiration for the agent and the deterministic fallback pool. */
export const SEED_DISHES: SeedDish[] = [
  { name: "Köttbullar med potatismos", mainCategory: "beef", prepTimeMinutes: 40 },
  { name: "Pasta med köttfärssås", mainCategory: "pasta", prepTimeMinutes: 35 },
  { name: "Pannkakor", mainCategory: "other", prepTimeMinutes: 30 },
  { name: "Fiskpinnar med potatis", mainCategory: "fish", prepTimeMinutes: 25 },
  { name: "Korv stroganoff med ris", mainCategory: "pork", prepTimeMinutes: 30 },
  { name: "Kycklinggryta med ris", mainCategory: "chicken", prepTimeMinutes: 40 },
  { name: "Tacos", mainCategory: "tacos", prepTimeMinutes: 25 },
  { name: "Ärtsoppa", mainCategory: "soup", prepTimeMinutes: 45 },
  { name: "Raggmunk med fläsk", mainCategory: "potatoes", prepTimeMinutes: 40 },
  { name: "Falukorv med makaroner", mainCategory: "pork", prepTimeMinutes: 20 },
  { name: "Lax i ugn med potatis", mainCategory: "fish", prepTimeMinutes: 35 },
  { name: "Pytt i panna", mainCategory: "potatoes", prepTimeMinutes: 30 },
  { name: "Kycklingnuggets med pommes", mainCategory: "chicken", prepTimeMinutes: 25 },
  { name: "Vegetarisk lasagne", mainCategory: "vegetarian", prepTimeMinutes: 60 },
  { name: "Tomatsoppa med bröd", mainCategory: "soup", prepTimeMinutes: 25 },
  { name: "Hamburgare", mainCategory: "beef", prepTimeMinutes: 30 },
  { name: "Wokad kyckling med ris", mainCategory: "chicken", prepTimeMinutes: 25 },
  { name: "Ugnsbakad korv med potatis", mainCategory: "pork", prepTimeMinutes: 35 },
  { name: "Grönsakssoppa", mainCategory: "soup", prepTimeMinutes: 35 },
  { name: "Omelett med sallad", mainCategory: "vegetarian", prepTimeMinutes: 15 },
];
