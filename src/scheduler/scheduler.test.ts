import cron from "node-cron";
import { describe, expect, it } from "vitest";
import { DEFAULT_CRON, startScheduler, type ScheduleFactory, type ScheduledJob } from "./scheduler.js";
import type { WeeklyRunDeps } from "./run-weekly.js";

/** A schedule factory that records registrations and lets the test fire the tick itself. */
function fakeSchedule() {
  const registered: { expression: string; timezone?: string; stopped: boolean; fire: () => Promise<unknown> }[] = [];
  const schedule: ScheduleFactory = (expression, onTick, options) => {
    const entry = { expression, timezone: options?.timezone, stopped: false, fire: () => Promise.resolve(onTick()) };
    registered.push(entry);
    const job: ScheduledJob = { stop: () => void (entry.stopped = true) };
    return job;
  };
  return { schedule, registered };
}

const deps = {} as WeeklyRunDeps;
const silent = { info() {}, warn() {}, error() {} };

describe("startScheduler", () => {
  it("defaults to Sunday 18:00, a valid cron expression", () => {
    expect(DEFAULT_CRON).toBe("0 18 * * 0");
    expect(cron.validate(DEFAULT_CRON)).toBe(true);
  });

  it("registers the task at the configured expression and runs onTick with the deps when it fires", async () => {
    const { schedule, registered } = fakeSchedule();
    const ticks: WeeklyRunDeps[] = [];
    const onTick = async (d: WeeklyRunDeps) => {
      ticks.push(d);
      return "ran";
    };

    const scheduler = startScheduler(deps, { cronExpression: "30 7 * * 1", timezone: "Europe/Stockholm", schedule, logger: silent }, onTick);
    expect(registered).toEqual([expect.objectContaining({ expression: "30 7 * * 1", timezone: "Europe/Stockholm" })]);
    expect(ticks).toHaveLength(0);

    await registered[0]!.fire();
    expect(ticks).toEqual([deps]);

    scheduler.stop();
    expect(registered[0]!.stopped).toBe(true);
  });

  it("logs and schedules nothing for an invalid expression instead of throwing", () => {
    const { schedule, registered } = fakeSchedule();
    const errors: string[] = [];

    const scheduler = startScheduler(deps, { cronExpression: "every sunday", schedule, logger: { ...silent, error: (m) => void errors.push(m) } });

    expect(registered).toEqual([]);
    expect(errors[0]).toContain("every sunday");
    expect(() => scheduler.stop()).not.toThrow();
  });

  it("reschedule stops the old task and registers the new expression", () => {
    const { schedule, registered } = fakeSchedule();
    const scheduler = startScheduler(deps, { cronExpression: DEFAULT_CRON, schedule, logger: silent });

    scheduler.reschedule("0 9 * * 6");

    expect(registered.map((r) => [r.expression, r.stopped])).toEqual([
      [DEFAULT_CRON, true],
      ["0 9 * * 6", false],
    ]);
  });

  it("a failing run is logged and does not kill the scheduler", async () => {
    const { schedule, registered } = fakeSchedule();
    const errors: string[] = [];
    startScheduler(deps, { cronExpression: DEFAULT_CRON, schedule, logger: { ...silent, error: (m) => void errors.push(m) } }, async () => {
      throw new Error("agent exploded");
    });

    await registered[0]!.fire();

    expect(errors[0]).toContain("agent exploded");
  });

  it("uses node-cron by default and accepts the default expression", () => {
    const scheduler = startScheduler(deps, { cronExpression: DEFAULT_CRON, logger: silent });
    expect(scheduler.isScheduled()).toBe(true);
    scheduler.stop();
    expect(scheduler.isScheduled()).toBe(false);
  });
});
