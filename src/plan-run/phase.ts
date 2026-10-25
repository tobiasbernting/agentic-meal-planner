/**
 * The Phases of a Plan Run (GLOSSARY.md), in the order the pipeline goes through them.
 * Pipeline modules report through an optional `onProgress` callback on their deps and stay
 * unaware of where the report goes (the route and the weekly run decide).
 */
export const PHASES = [
  "lunch-ingest",
  "dish-selection",
  "ingredient-resolution",
  "pantry-matching",
  "shopping-list-update",
] as const;

export type Phase = (typeof PHASES)[number];

/** Ingredient resolution progress, reported as each Dish starts: `done` of `total` resolved so far. */
export interface PhaseProgress {
  done: number;
  total: number;
  /** Name of the Dish being resolved now. */
  dish: string;
}

/**
 * One report: a Phase transition (no `progress`), or progress within the current Phase
 * (`progress` set; only Ingredient resolution reports it today).
 */
export interface PlanRunEvent {
  phase: Phase;
  progress?: PhaseProgress;
}

export type OnProgress = (event: PlanRunEvent) => void;
