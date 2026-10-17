import { describe, expect, it } from "vitest";
import { fastifyLoggerOptions, resolveLogLevel } from "./config.js";

describe("resolveLogLevel", () => {
  it("honours LOG_LEVEL", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "warn", NODE_ENV: "production" })).toBe("warn");
    expect(resolveLogLevel({ LOG_LEVEL: "ERROR" })).toBe("error");
  });

  it("defaults to info in production and debug otherwise", () => {
    expect(resolveLogLevel({ NODE_ENV: "production" })).toBe("info");
    expect(resolveLogLevel({})).toBe("debug");
    expect(resolveLogLevel({ NODE_ENV: "development" })).toBe("debug");
  });

  it("accepts silent", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "silent" })).toBe("silent");
    expect(fastifyLoggerOptions({ LOG_LEVEL: "silent" })).toEqual({ level: "silent" });
  });

  it("ignores an unknown LOG_LEVEL", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "loud", NODE_ENV: "production" })).toBe("info");
  });
});

describe("fastifyLoggerOptions", () => {
  it("emits plain JSON lines in production", () => {
    expect(fastifyLoggerOptions({ NODE_ENV: "production" })).toEqual({ level: "info" });
  });

  it("pretty-prints outside production", () => {
    expect(fastifyLoggerOptions({ LOG_LEVEL: "info" })).toEqual({ level: "info", transport: { target: "pino-pretty" } });
  });
});
