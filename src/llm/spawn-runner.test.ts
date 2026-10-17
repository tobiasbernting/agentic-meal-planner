import { describe, expect, it } from "vitest";
import { createCapturingLogger } from "../logging/logger.js";
import { AgentTimeoutError, CliAgent, spawnRunner } from "./cli-agent.js";

// The only tests that spawn processes: `node -e` scripts stand in for the agent CLI.
const node = process.execPath;

describe("spawnRunner", () => {
  it("captures stderr and the exit code", async () => {
    const out = await spawnRunner(node, ["-e", 'process.stdout.write("out"); process.stderr.write("auth required"); process.exit(2)'], "", 5_000);

    expect(out).toEqual({ stdout: "out", stderr: "auth required", exitCode: 2 });
  });

  it("keeps only the last 8 KB of stderr", async () => {
    const out = await spawnRunner(node, ["-e", 'process.stderr.write("x".repeat(20000) + "END")'], "", 5_000);

    expect(out.stderr).toHaveLength(8192);
    expect(out.stderr.endsWith("END")).toBe(true);
  });

  it("kills a process that runs past the timeout and rejects with AgentTimeoutError", async () => {
    const started = Date.now();
    const run = spawnRunner(node, ["-e", 'process.stderr.write("working"); setTimeout(() => {}, 10000)'], "", 300);

    await expect(run).rejects.toBeInstanceOf(AgentTimeoutError);
    await expect(run).rejects.toMatchObject({ timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("rejects with ENOENT when the binary does not exist", async () => {
    await expect(spawnRunner("mp-no-such-agent-binary", [], "", 5_000)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("CliAgent with the real spawner", () => {
  it("puts the agent's stderr in the reason when it exits non-zero", async () => {
    const { logger, records } = createCapturingLogger();
    const agent = new CliAgent(`${node} -e process.stderr.write("Error:_not_logged_in");process.exit(2)`, { log: logger });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: false, reason: "agent exited with code 2: Error:_not_logged_in" });
    expect(records.find((r) => r.level === "warn")).toMatchObject({ cause: "exit", exitCode: 2 });
  });

  it("reports a timeout", async () => {
    const { logger, records } = createCapturingLogger();
    const agent = new CliAgent(`${node} -e setTimeout(()=>{},10000)`, { timeoutMs: 200, log: logger });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: false, reason: "agent timed out after 200ms" });
    expect(records.find((r) => r.level === "warn")).toMatchObject({ cause: "timeout" });
  });

  it("reports a nonexistent binary as not found", async () => {
    const { logger, records } = createCapturingLogger();
    const agent = new CliAgent("mp-no-such-agent-binary -p", { log: logger });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: false, reason: "agent binary not found: mp-no-such-agent-binary" });
    expect(records.find((r) => r.level === "warn")).toMatchObject({ cause: "not-found" });
  });
});
