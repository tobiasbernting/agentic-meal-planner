/**
 * The fixed Main Category list (GLOSSARY: Main Category). A Dish or Lunch Entry is stored by
 * key; labels are presentation only (FR-18 requires sv + en). `other` means uncategorised
 * and never triggers a category collision (FR-6b).
 */

export const MAIN_CATEGORY_KEYS = [
  "pasta",
  "rice",
  "potatoes",
  "fish",
  "chicken",
  "beef",
  "pork",
  "vegetarian",
  "soup",
  "tacos",
  "other",
] as const;

export type MainCategory = (typeof MAIN_CATEGORY_KEYS)[number];

export interface CategoryLabels {
  en: string;
  sv: string;
}

export const MAIN_CATEGORIES: Record<MainCategory, CategoryLabels> = {
  pasta: { en: "Pasta", sv: "Pasta" },
  rice: { en: "Rice", sv: "Ris" },
  potatoes: { en: "Potatoes", sv: "Potatis" },
  fish: { en: "Fish", sv: "Fisk" },
  chicken: { en: "Chicken", sv: "Kyckling" },
  beef: { en: "Beef", sv: "Nötkött" },
  pork: { en: "Pork", sv: "Fläsk" },
  vegetarian: { en: "Vegetarian", sv: "Vegetariskt" },
  soup: { en: "Soup", sv: "Soppa" },
  tacos: { en: "Tacos", sv: "Tacos" },
  other: { en: "Other", sv: "Övrigt" },
};

export function isMainCategory(value: unknown): value is MainCategory {
  return typeof value === "string" && (MAIN_CATEGORY_KEYS as readonly string[]).includes(value);
}
