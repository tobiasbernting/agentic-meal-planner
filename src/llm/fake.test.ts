import { describe, expect, it } from "vitest";
import { ScriptedLlmAgent } from "./fake.js";

describe("ScriptedLlmAgent", () => {
  it("holds a call until the scripted function's Promise settles", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const llm = new ScriptedLlmAgent({
      findRecipe: async (dishName) => {
        await held;
        return { ok: true, value: { url: `https://recipes.example/${dishName}`, ingredients: [] } };
      },
    });

    let settled = false;
    const call = llm.findRecipe("Kalops").then((r) => ((settled = true), r));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    expect(llm.calls).toEqual([{ method: "findRecipe", args: ["Kalops", {}] }]);

    release();
    expect(await call).toEqual({ ok: true, value: { url: "https://recipes.example/Kalops", ingredients: [] } });
  });
});
