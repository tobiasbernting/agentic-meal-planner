import { describe, expect, it } from "vitest";
import { CliAgent } from "./cli-agent.js";
import { ScriptedLlmAgent } from "./fake.js";
import { createLlmAgent } from "./index.js";
import { NoAgent } from "./no-agent.js";

describe("createLlmAgent", () => {
  it("returns NoAgent when no command is configured", () => {
    expect(createLlmAgent(undefined)).toBeInstanceOf(NoAgent);
    expect(createLlmAgent("")).toBeInstanceOf(NoAgent);
    expect(createLlmAgent("   ")).toBeInstanceOf(NoAgent);
  });

  it("returns a CliAgent using the injected runner when a command is configured", async () => {
    const calls: string[] = [];
    const agent = createLlmAgent("copilot -p", {
      run: async (cmd) => {
        calls.push(cmd);
        return { stdout: '[{"name":"milk"}]', exitCode: 0 };
      },
    });

    expect(agent).toBeInstanceOf(CliAgent);
    expect(await agent.extractIngredients("page")).toEqual({ ok: true, value: [{ name: "milk" }] });
    expect(calls).toEqual(["copilot"]);
  });
});

describe("ScriptedLlmAgent", () => {
  it("replies with the scripted result per method and degrades when nothing is scripted", async () => {
    const agent = new ScriptedLlmAgent({
      extractIngredients: { ok: true, value: [{ name: "flour", quantity: 2, unit: "dl" }] },
      selectDishes: (input) => ({
        ok: true,
        value: input.days.map((d, i) => ({ date: d.date, dishId: input.candidates[i]![0]!.id, rationale: "scripted" })),
      }),
    });

    expect(await agent.extractIngredients("page")).toEqual({ ok: true, value: [{ name: "flour", quantity: 2, unit: "dl" }] });
    expect(
      await agent.selectDishes({
        days: [{ date: "2026-10-19", isQuickDay: false, lunch: [] }],
        candidates: [[{ id: "d1", name: "Tacos" }]],
        recentlyPlanned: [],
      }),
    ).toEqual({ ok: true, value: [{ date: "2026-10-19", dishId: "d1", rationale: "scripted" }] });
    expect(await agent.findRecipe("Tacos")).toEqual({ ok: false, reason: "no scripted response for findRecipe" });
    expect(agent.calls.map((c) => c.method)).toEqual(["extractIngredients", "selectDishes", "findRecipe"]);
  });
});
