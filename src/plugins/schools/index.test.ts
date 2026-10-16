import { describe, expect, it } from "vitest";
import type { SchoolPlugin } from "../../types.js";
import { createSchoolPlugins, findPlugin } from "./index.js";

describe("School Plugin registry", () => {
  it("returns the first plugin that claims the URL", () => {
    const first: SchoolPlugin = { id: "first", claims: (url) => url.includes("x"), scrape: async () => [] };
    const second: SchoolPlugin = { id: "second", claims: (url) => url.includes("x"), scrape: async () => [] };

    expect(findPlugin("https://x.example", [first, second])?.id).toBe("first");
  });

  it("returns undefined when no plugin claims the URL (LLM fallback)", () => {
    const plugins = createSchoolPlugins(async () => "");

    expect(findPlugin("https://unknown-school.example/menu", plugins)).toBeUndefined();
  });

  it("ships the example JSON plugin so a URL ending in .lunch.json is claimed", () => {
    const plugins = createSchoolPlugins(async () => "");

    expect(findPlugin("https://school.example/week.lunch.json", plugins)?.id).toBe("example-json");
  });
});
