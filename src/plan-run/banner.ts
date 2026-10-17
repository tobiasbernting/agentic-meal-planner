/**
 * The Plan Run banner for one week (spec #61): an HTML fragment pages embed and the banner
 * route serves. In flight it polls its own route every 2s and replaces itself; once the run
 * has ended it carries no polling attributes, so polling stops.
 */
import { t, type Lang } from "../i18n/index.js";
import { escapeHtml } from "../ui/layout.js";
import { localTime } from "../week.js";
import { PHASES, type Phase } from "./phase.js";
import type { PlanRunState } from "./registry.js";
import type { LunchChange } from "../lunch/ingest.js";

export const BANNER_ID = "plan-run-banner";

/** What an in-flight banner last showed, sent back by its poll: a Phase, or `start` before the first one. */
export type ShownPhase = Phase | "start";

export function isShownPhase(value: string | undefined): value is ShownPhase {
  return value === "start" || (PHASES as readonly string[]).includes(value ?? "");
}

export function bannerUrl(weekStart: string, shown?: ShownPhase): string {
  return `/plan-run/banner?week=${weekStart}${shown ? `&amp;shown=${shown}` : ""}`;
}

/** Index of the first Phase after the Weekly Plan is saved: the page must reload to show the dinners. */
const AFTER_SELECTION = PHASES.indexOf("ingredient-resolution");

/**
 * True when the page under a banner that showed `shown` is out of date with `state`: the run
 * has ended, or the dinners were saved since. The banner route then asks HTMX to reload the page.
 */
export function pageIsStale(shown: ShownPhase, state: PlanRunState | undefined): boolean {
  if (!state || !("inFlight" in state)) return true;
  const before = shown === "start" ? -1 : PHASES.indexOf(shown);
  const now = state.inFlight.phase ? PHASES.indexOf(state.inFlight.phase) : -1;
  return before < AFTER_SELECTION && now >= AFTER_SELECTION;
}

export interface BannerOptions {
  /** Household time zone for the HH:MM times; process time zone when absent. */
  timezone?: string | undefined;
  /** "School date" labels for the Lunch Entries a finished run found changed. */
  describeChanges?: (changes: LunchChange[]) => string[];
}

export function renderPlanRunBanner(lang: Lang, weekStart: string, state: PlanRunState | undefined, { timezone, describeChanges }: BannerOptions = {}): string {
  if (state && "inFlight" in state) {
    const { startedAt, phase, progress } = state.inFlight;
    const shown: ShownPhase = phase ?? "start";
    const phaseText = phase ? t(lang, `planRun.phase.${phase}`) : t(lang, "planRun.starting");
    const progressText = progress
      ? `<p class="plan-run-progress">${escapeHtml(t(lang, "planRun.progress", { done: progress.done, total: progress.total, dish: progress.dish }))}</p>`
      : "";
    return `<div id="${BANNER_ID}" class="plan-run notice" hx-get="${bannerUrl(weekStart, shown)}" hx-trigger="every 2s" hx-swap="outerHTML">
  <p>${escapeHtml(t(lang, "planRun.inProgress", { time: localTime(startedAt, timezone) }))}</p>
  <p class="plan-run-phase">${escapeHtml(t(lang, "planRun.phase"))}: ${escapeHtml(phaseText)}</p>
  ${progressText}
</div>`;
  }
  if (state?.outcome.kind === "finished") {
    const { at, lunchChanged } = state.outcome;
    return `<div id="${BANNER_ID}" class="plan-run">
  <p>${escapeHtml(t(lang, "planRun.finished", { time: localTime(at, timezone) }))}</p>
  ${lunchChanged.length ? lunchChangedNotice(lang, describeChanges ? describeChanges(lunchChanged) : []) : ""}
</div>`;
  }
  if (state?.outcome.kind === "failed") {
    const { at, message } = state.outcome;
    return `<div id="${BANNER_ID}" class="plan-run plan-run-failed">
  <p>${escapeHtml(t(lang, "planRun.failed", { time: localTime(at, timezone), reason: message }))}</p>
</div>`;
  }
  return `<div id="${BANNER_ID}" class="plan-run"></div>`;
}

/** Q17: which stored Lunch Entries a Regenerate found changed. */
function lunchChangedNotice(lang: Lang, labels: string[]): string {
  return `<p class="notice">${escapeHtml(`${t(lang, "plan.notice.lunch-changed")}${labels.length ? `: ${labels.join(", ")}` : ""}`)}</p>`;
}
