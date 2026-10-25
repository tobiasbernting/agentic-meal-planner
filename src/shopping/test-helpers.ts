import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { savePlan } from "../planner/repo.js";
import { addDays } from "../week.js";
import { updateShoppingList } from "./shares.js";

/** Saves a plan for the week with one Dish per date from Monday on (null leaves the date empty). Returns the plan id. */
export function planWeek(db: Database.Database, weekStart: string, dishIds: (number | null)[], generatedAt: string): number {
  return savePlan(
    db,
    {
      weekStart,
      dinners: dishIds.map((dishId, i) => ({ date: addDays(weekStart, i), dishId, suggestion: null, isQuickDay: false, lunchThatDay: null, rationale: "r" })),
      degradedReasons: [],
    },
    generatedAt,
  );
}

/** Runs the Shopping List update for a stored plan as a Plan Run would, with the app's ports. */
export function updateList(app: FastifyInstance, planId: number, language: "sv" | "en" = "en") {
  return updateShoppingList({ db: app.ctx.db, llm: app.ctx.llm, fetchPage: app.ctx.fetchPage, now: app.ctx.now, language }, planId);
}

/** The lines of a section of the rendered Shopping page as [label, checked], in document order. */
export function sectionLines(html: string, section: "buy" | "check-pantry"): [string, boolean][] {
  const block = new RegExp(`<section id="${section}">([\\s\\S]*?)</section>`).exec(html)?.[1] ?? "";
  return [...block.matchAll(/<li class="row line([^"]*)"[\s\S]*?<(?:span|s) class="row-label">([^<]*)<\/(?:span|s)>/g)].map((m) => [m[2]!, m[1]!.includes("line-checked")]);
}

/** The id of the line whose normalised name is `name`, from the rendered page. */
export function lineIdOf(html: string, name: string): string {
  const m = new RegExp(`<li class="row line[^"]*" data-line="(\\d+)" data-name="${name}"`).exec(html);
  if (!m) throw new Error(`no line named ${name}`);
  return m[1]!;
}
