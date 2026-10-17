import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentBinary, agentBinaryFound, startupReport } from "./startup.js";

/** A temp dir holding an executable `name` and a non-executable `plain`. */
function binDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mp-bin-"));
  writeFileSync(join(dir, name), "#!/bin/sh\n");
  chmodSync(join(dir, name), 0o755);
  writeFileSync(join(dir, "plain"), "");
  chmodSync(join(dir, "plain"), 0o644);
  mkdirSync(join(dir, "adir"));
  return dir;
}

describe("agentBinary", () => {
  it("is the first token of the command", () => {
    expect(agentBinary("copilot -p")).toBe("copilot");
    expect(agentBinary("  claude  --print ")).toBe("claude");
    expect(agentBinary("")).toBeUndefined();
    expect(agentBinary(undefined)).toBeUndefined();
  });
});

describe("agentBinaryFound", () => {
  it("finds an executable in a PATH directory", () => {
    const dir = binDir("fakeagent");
    expect(agentBinaryFound("fakeagent -p", { PATH: `/nonexistent:${dir}` })).toBe(true);
  });

  it("is false when no PATH directory has it, or it is not executable, or a directory", () => {
    const dir = binDir("fakeagent");
    expect(agentBinaryFound("missing-agent", { PATH: dir })).toBe(false);
    expect(agentBinaryFound("plain", { PATH: dir })).toBe(false);
    expect(agentBinaryFound("adir", { PATH: dir })).toBe(false);
    expect(agentBinaryFound("fakeagent", {})).toBe(false);
  });

  it("checks an absolute or relative path directly", () => {
    const dir = binDir("fakeagent");
    expect(agentBinaryFound(`${join(dir, "fakeagent")} -p`, { PATH: "" })).toBe(true);
    expect(agentBinaryFound(join(dir, "nope"), { PATH: dir })).toBe(false);
  });

  it("is false when no agent is configured", () => {
    expect(agentBinaryFound(undefined, { PATH: "/bin" })).toBe(false);
  });
});

describe("startupReport", () => {
  it("states what the server resolved", () => {
    const dir = binDir("fakeagent");
    expect(
      startupReport({ agentCommand: "fakeagent -p", env: { PATH: dir, TZ: "Europe/Stockholm" }, cronExpression: "0 18 * * 0", dataDir: "/data" }),
    ).toEqual({
      agentCommand: "fakeagent -p",
      agentBinary: "fakeagent",
      agentBinaryFound: true,
      tz: "Europe/Stockholm",
      dataDir: "/data",
      cronExpression: "0 18 * * 0",
    });
  });

  it("reports a settings time zone, and the process zone when TZ is unset", () => {
    const report = startupReport({ agentCommand: undefined, env: {}, cronExpression: "x", dataDir: "d", timezone: "Asia/Tokyo" });
    expect(report).toMatchObject({ agentCommand: null, agentBinary: null, agentBinaryFound: false, timezone: "Asia/Tokyo" });
    expect(typeof report.tz).toBe("string");
  });
});
