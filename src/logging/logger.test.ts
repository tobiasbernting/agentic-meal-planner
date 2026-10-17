import { describe, expect, it } from "vitest";
import { createCapturingLogger, pinoLogger, truncateFields } from "./logger.js";

describe("truncateFields", () => {
  it("leaves short fields alone", () => {
    expect(truncateFields({ a: "short", n: 3 })).toEqual({ a: "short", n: 3 });
  });

  it("cuts strings over the limit and says how much was dropped", () => {
    const out = truncateFields({ stdout: "x".repeat(10) }, 4);
    expect(out.stdout).toBe("xxxx…[truncated 6 chars]");
  });

  it("defaults to 8 KB", () => {
    const out = truncateFields({ page: "y".repeat(8192 + 100) });
    expect(out.page).toBe(`${"y".repeat(8192)}…[truncated 100 chars]`);
  });

  it("truncates strings one level down in nested objects", () => {
    const out = truncateFields({ agent: { stderr: "z".repeat(7) } }, 2);
    expect(out.agent).toEqual({ stderr: "zz…[truncated 5 chars]" });
  });

  it("truncates strings at any depth, through arrays and nested objects", () => {
    const out = truncateFields({ run: { attempts: [{ stderr: "z".repeat(7) }, "w".repeat(3)] } }, 2);
    expect(out.run).toEqual({ attempts: [{ stderr: "zz…[truncated 5 chars]" }, "ww…[truncated 1 chars]"] });
  });

  it("stops descending past a bounded depth, so a cycle cannot loop", () => {
    const cyclic: Record<string, unknown> = { s: "abc" };
    cyclic.self = cyclic;
    expect(() => truncateFields({ cyclic }, 2)).not.toThrow();
  });

  it("keeps Error objects intact", () => {
    const err = new Error("boom");
    expect(truncateFields({ err }).err).toBe(err);
  });
});

describe("createCapturingLogger", () => {
  it("records level, message and fields, with child bindings merged", () => {
    const { logger, records } = createCapturingLogger();

    logger.child({ runId: "r1" }).child({ component: "planner" }).warn({ reason: "x" }, "fallback taken");
    logger.info({}, "hello");

    expect(records).toEqual([
      { level: "warn", msg: "fallback taken", runId: "r1", component: "planner", reason: "x" },
      { level: "info", msg: "hello" },
    ]);
  });

  it("truncates long fields like the real logger", () => {
    const { logger, records } = createCapturingLogger();
    logger.debug({ prompt: "p".repeat(9000) }, "prompt");
    expect(String(records[0]!.prompt)).toContain("…[truncated 808 chars]");
  });
});

describe("pinoLogger", () => {
  it("forwards fields (truncated) and message to pino, and children bind fields", () => {
    const calls: unknown[][] = [];
    const fake = {
      debug: (...a: unknown[]) => void calls.push(["debug", ...a]),
      info: (...a: unknown[]) => void calls.push(["info", ...a]),
      warn: (...a: unknown[]) => void calls.push(["warn", ...a]),
      error: (...a: unknown[]) => void calls.push(["error", ...a]),
      child(bindings: Record<string, unknown>) {
        calls.push(["child", bindings]);
        return fake;
      },
    };

    const log = pinoLogger(fake);
    log.child({ runId: "r" }).error({ big: "b".repeat(9000) }, "failed");

    expect(calls[0]).toEqual(["child", { runId: "r" }]);
    expect(calls[1]![0]).toBe("error");
    expect(String((calls[1]![1] as Record<string, unknown>).big)).toContain("…[truncated 808 chars]");
    expect(calls[1]![2]).toBe("failed");
  });
});
