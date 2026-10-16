import { describe, expect, it } from "vitest";
import { CliAgent, type ProcessRunner } from "./cli-agent.js";

/** A runner that replies with the scripted stdouts in order and records every call. */
function scriptedRunner(replies: string[]) {
  const calls: { cmd: string; args: string[]; stdin: string }[] = [];
  const run: ProcessRunner = async (cmd, args, stdin) => {
    calls.push({ cmd, args, stdin });
    const stdout = replies.shift() ?? "";
    return { stdout, exitCode: 0 };
  };
  return { run, calls };
}

describe("CliAgent.extractIngredients", () => {
  it("parses a valid JSON response", async () => {
    const { run, calls } = scriptedRunner([
      JSON.stringify([
        { name: "spaghetti", quantity: 400, unit: "g" },
        { name: "minced beef", quantity: "500", unit: "g" },
        { name: "salt" },
      ]),
    ]);
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.extractIngredients("<html>Spaghetti bolognese ...</html>");

    expect(result).toEqual({
      ok: true,
      value: [
        { name: "spaghetti", quantity: 400, unit: "g" },
        { name: "minced beef", quantity: "500", unit: "g" },
        { name: "salt" },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("copilot");
    expect(calls[0]!.args[0]).toBe("-p");
    expect(calls[0]!.args.at(-1)).toContain("Spaghetti bolognese");
    expect(calls[0]!.stdin).toBe(calls[0]!.args.at(-1));
  });

  it("extracts the JSON from code fences and surrounding prose", async () => {
    const { run } = scriptedRunner([
      'Sure! Here is the list:\n```json\n[{"name": "eggs", "quantity": 6}]\n```\nLet me know if you need anything else.',
    ]);
    const agent = new CliAgent("claude -p", { run });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: true, value: [{ name: "eggs", quantity: 6 }] });
  });

  it("retries once with a JSON-only nudge when the response is not valid JSON", async () => {
    const { run, calls } = scriptedRunner(["I could not find any ingredients, sorry.", '[{"name": "milk"}]']);
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: true, value: [{ name: "milk" }] });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args.at(-1)).toMatch(/JSON only/i);
  });

  it("retries when the JSON has the wrong shape", async () => {
    const { run, calls } = scriptedRunner(['{"ingredients": "none"}', '[{"name": "milk"}]']);
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: true, value: [{ name: "milk" }] });
    expect(calls).toHaveLength(2);
  });

  it("degrades instead of throwing after two failures", async () => {
    const { run, calls } = scriptedRunner(["nope", "still nope"]);
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: false, reason: "invalid JSON after retry" });
    expect(calls).toHaveLength(2);
  });

  it("degrades when the agent process fails", async () => {
    const run: ProcessRunner = async () => {
      throw new Error("spawn copilot ENOENT");
    };
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: false, reason: "agent failed: spawn copilot ENOENT" });
  });

  it("degrades when the agent exits non-zero", async () => {
    const run: ProcessRunner = async () => ({ stdout: "", exitCode: 1 });
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: false, reason: "agent exited with code 1" });
  });
});

describe("CliAgent.extractLunchMenu", () => {
  it("parses lunch entries and mentions the week start in the prompt", async () => {
    const { run, calls } = scriptedRunner([
      JSON.stringify([
        { date: "2026-10-19", rawText: "Pannkakor med sylt", normalizedName: "Pannkakor", mainCategory: "other" },
        { date: "2026-10-20", rawText: "Fiskgratäng" },
      ]),
    ]);
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.extractLunchMenu("<html>menu</html>", "2026-10-19");

    expect(result).toEqual({
      ok: true,
      value: [
        { date: "2026-10-19", rawText: "Pannkakor med sylt", normalizedName: "Pannkakor", mainCategory: "other" },
        { date: "2026-10-20", rawText: "Fiskgratäng" },
      ],
    });
    expect(calls[0]!.args.at(-1)).toContain("2026-10-19");
  });

  it("rejects entries whose date is not YYYY-MM-DD", async () => {
    const { run } = scriptedRunner(['[{"date": "Monday", "rawText": "Soppa"}]', '[{"date": "Monday", "rawText": "Soppa"}]']);
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.extractLunchMenu("page", "2026-10-19");

    expect(result).toEqual({ ok: false, reason: "invalid JSON after retry" });
  });
});

describe("CliAgent.findRecipe", () => {
  it("parses a url with ingredients", async () => {
    const { run, calls } = scriptedRunner([
      '{"url": "https://example.com/tacos", "ingredients": [{"name": "tortillas", "quantity": 8}]}',
    ]);
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.findRecipe("Tacos");

    expect(result).toEqual({
      ok: true,
      value: { url: "https://example.com/tacos", ingredients: [{ name: "tortillas", quantity: 8 }] },
    });
    expect(calls[0]!.args.at(-1)).toContain("Tacos");
  });
});

describe("CliAgent.matchPantryItems", () => {
  const input = {
    ingredients: ["whole milk", "saffron"],
    pantry: [
      { id: "1", name: "milk", aliases: ["mjölk"] },
      { id: "2", name: "flour", aliases: [] },
    ],
  };

  it("parses matches and includes the ingredients and pantry aliases in the prompt", async () => {
    const { run, calls } = scriptedRunner([
      JSON.stringify([
        { ingredient: "whole milk", pantryId: "1" },
        { ingredient: "saffron", pantryId: null },
      ]),
    ]);
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.matchPantryItems(input);

    expect(result).toEqual({
      ok: true,
      value: [
        { ingredient: "whole milk", pantryId: "1" },
        { ingredient: "saffron", pantryId: null },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.at(-1)).toContain("saffron");
    expect(calls[0]!.args.at(-1)).toContain("mjölk");
  });

  it("accepts numeric pantry ids and returns them as strings", async () => {
    const { run } = scriptedRunner(['[{"ingredient": "whole milk", "pantryId": 1}]']);
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.matchPantryItems(input);

    expect(result).toEqual({ ok: true, value: [{ ingredient: "whole milk", pantryId: "1" }] });
  });

  it("rejects a match to a pantry id that does not exist", async () => {
    const bad = '[{"ingredient": "whole milk", "pantryId": "99"}]';
    const { run } = scriptedRunner([bad, bad]);
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.matchPantryItems(input);

    expect(result).toEqual({ ok: false, reason: "invalid JSON after retry" });
  });
});

describe("CliAgent.selectDishes", () => {
  const input = {
    days: [
      { date: "2026-10-19", isQuickDay: false, lunch: [{ date: "2026-10-19", rawText: "Pasta" }] },
      { date: "2026-10-20", isQuickDay: true, lunch: [] },
    ],
    candidates: [
      [
        { id: "d1", name: "Tacos" },
        { id: "d2", name: "Burgers" },
      ],
      [{ id: "d2", name: "Burgers" }],
    ],
    recentlyPlanned: [{ dishId: "d1", lastDate: "2026-10-12" }],
  };

  it("parses a selection and includes the candidates in the prompt", async () => {
    const { run, calls } = scriptedRunner([
      JSON.stringify([
        { date: "2026-10-19", dishId: "d1", rationale: "Tacos avoid the pasta lunch" },
        { date: "2026-10-20", dishId: "d2", rationale: "Only quick candidate" },
      ]),
    ]);
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.selectDishes(input);

    expect(result).toEqual({
      ok: true,
      value: [
        { date: "2026-10-19", dishId: "d1", rationale: "Tacos avoid the pasta lunch" },
        { date: "2026-10-20", dishId: "d2", rationale: "Only quick candidate" },
      ],
    });
    expect(calls[0]!.args.at(-1)).toContain("Burgers");
  });

  it("accepts numeric dish ids on both sides and returns them as strings", async () => {
    const { run } = scriptedRunner(['[{"date": "2026-10-19", "dishId": 7, "rationale": "ok"}]']);
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.selectDishes({
      days: [{ date: "2026-10-19", isQuickDay: false, lunch: [] }],
      candidates: [[{ id: 7, name: "Tacos" }]],
      recentlyPlanned: [],
    });

    expect(result).toEqual({ ok: true, value: [{ date: "2026-10-19", dishId: "7", rationale: "ok" }] });
  });

  it("rejects a selection of a dish that was not a candidate for that day", async () => {
    const bad = JSON.stringify([
      { date: "2026-10-19", dishId: "d1", rationale: "ok" },
      { date: "2026-10-20", dishId: "d1", rationale: "not a candidate on tuesday" },
    ]);
    const { run } = scriptedRunner([bad, bad]);
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.selectDishes(input);

    expect(result).toEqual({ ok: false, reason: "invalid JSON after retry" });
  });
});
