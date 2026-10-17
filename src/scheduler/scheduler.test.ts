import cron from "node-cron";
import { describe, expect, it } from "vitest";
import { DEFAULT_CRON, startScheduler, type ScheduleFactory, type ScheduledJob } from "./scheduler.js";
import type { WeeklyRunDeps } from "./run-weekly.js";
import { createCapturingLogger, silentLogger } from "../logging/logger.js";

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

const deps = { now: () => new Date() } as WeeklyRunDeps;
const silent = silentLogger;

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
    expect(ticks).toEqual([{ ...deps, log: expect.anything() }]);

    scheduler.stop();
    expect(registered[0]!.stopped).toBe(true);
  });

  it("logs and schedules nothing for an invalid expression instead of throwing", () => {
    const { schedule, registered } = fakeSchedule();
    const { logger, records } = createCapturingLogger();

    const scheduler = startScheduler(deps, { cronExpression: "every sunday", schedule, logger });

    expect(registered).toEqual([]);
    expect(records).toContainEqual(expect.objectContaining({ level: "error", cronExpression: "every sunday" }));
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

  it("reschedule picks up a changed timezone, and clears it when none is given", () => {
    const zones: (string | undefined)[] = [];
    const schedule = (_e: string, _t: () => Promise<unknown>, o?: { timezone?: string }) => (zones.push(o?.timezone), { stop() {} });
    const scheduler = startScheduler(deps, { cronExpression: DEFAULT_CRON, schedule, logger: silent });

    scheduler.reschedule(DEFAULT_CRON, "Europe/Stockholm");
    scheduler.reschedule(DEFAULT_CRON);

    expect(zones).toEqual([undefined, "Europe/Stockholm", undefined]);
  });

  it("a failing run is logged with the error stack and does not kill the scheduler", async () => {
    const { schedule, registered } = fakeSchedule();
    const { logger, records } = createCapturingLogger();
    const scheduler = startScheduler(deps, { cronExpression: DEFAULT_CRON, schedule, logger }, async () => {
      throw new Error("agent exploded");
    });

    await registered[0]!.fire();

    const failed = records.find((r) => r.msg === "run failed");
    expect(failed).toMatchObject({ level: "error", runId: expect.stringMatching(/^cron-/) });
    expect(failed!.err).toBeInstanceOf(Error);
    expect((failed!.err as Error).stack).toContain("agent exploded");
    expect(scheduler.isScheduled()).toBe(true);
  });

  it("each tick runs under its own cron-<ISO> runId, passed to the run as deps.log", async () => {
    const { schedule, registered } = fakeSchedule();
    const { logger, records } = createCapturingLogger();
    startScheduler(deps, { cronExpression: DEFAULT_CRON, schedule, logger }, async (d) => {
      d.log?.info({}, "inside the run");
    });

    await registered[0]!.fire();

    const inside = records.find((r) => r.msg === "inside the run");
    expect(inside?.runId).toMatch(/^cron-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const run = records.filter((r) => r.runId === inside!.runId).map((r) => r.msg);
    expect(run).toEqual(["run started", "inside the run", "run finished"]);
  });

  it("tags records from loggers outside the run's deps with the tick's runId", async () => {
    const { schedule, registered } = fakeSchedule();
    const { logger, records } = createCapturingLogger();
    const shared = logger.child({ component: "llm" });
    startScheduler(deps, { cronExpression: DEFAULT_CRON, schedule, logger }, async () => {
      await Promise.resolve();
      shared.info({}, "agent call finished");
    });

    await registered[0]!.fire();

    const started = records.find((r) => r.msg === "run started");
    expect(records.find((r) => r.msg === "agent call finished")).toMatchObject({ component: "llm", runId: started!.runId });
    expect(started!.runId).toMatch(/^cron-/);
  });

  it("uses node-cron by default and accepts the default expression", () => {
    const scheduler = startScheduler(deps, { cronExpression: DEFAULT_CRON, logger: silent });
    expect(scheduler.isScheduled()).toBe(true);
    scheduler.stop();
    expect(scheduler.isScheduled()).toBe(false);
  });
});
