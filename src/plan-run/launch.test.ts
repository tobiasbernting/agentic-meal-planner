import { describe, expect, it } from "vitest";
import { createCapturingLogger } from "../logging/logger.js";
import { launchPlanRun } from "./launch.js";
import { createPlanRunRegistry, type PlanRunRegistry } from "./registry.js";

const WEEK = "2026-10-19";
const NOW = new Date(2026, 9, 21, 18, 30);

/** Waits (briefly) for a condition the detached run reaches on its own. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition not reached");
}

describe("launchPlanRun", () => {
  it("logs at error level, instead of leaving an unhandled rejection, when ending the run throws", async () => {
    const { logger, records } = createCapturingLogger();
    const registry = createPlanRunRegistry();
    const planRuns: PlanRunRegistry = {
      ...registry,
      finish: () => {
        throw new Error("registry broke");
      },
    };

    launchPlanRun({ planRuns, now: () => NOW, log: logger }, { weekStart: WEEK, runId: "req-1" }, async () => ({}));

    await until(() => records.some((r) => r.level === "error"));
    expect(records).toContainEqual(expect.objectContaining({ level: "error", component: "plan-run", weekStart: WEEK, err: "registry broke" }));
  });
});
