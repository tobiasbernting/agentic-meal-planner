import { describe, expect, it } from "vitest";
import { createCapturingLogger } from "../logging/logger.js";
import { AgentTimeoutError, CliAgent, type ProcessRunner } from "./cli-agent.js";

/** A runner that replies with the scripted stdouts in order and records every call. */
function scriptedRunner(replies: string[]) {
  const calls: { cmd: string; args: string[]; stdin: string }[] = [];
  const run: ProcessRunner = async (cmd, args, stdin) => {
    calls.push({ cmd, args, stdin });
    const stdout = replies.shift() ?? "";
    return { stdout, stderr: "", exitCode: 0 };
  };
  return { run, calls };
}

describe("CliAgent Ingredient cleaning", () => {
  it("asks extraction for a bare shopping name, the UI language, metric units and a separate Preparation Note", async () => {
    const { run, calls } = scriptedRunner(['[{"name": "mjölk"}]', '{"url": "https://x.example", "ingredients": []}']);
    const agent = new CliAgent("claude -p", { run });

    await agent.extractIngredients("page", { language: "sv" });
    await agent.findRecipe("Mos", { language: "en" });

    const [extract, find] = calls.map((c) => c.args.at(-1)!);
    expect(extract).toMatch(/Swedish/);
    expect(find).toMatch(/English/);
    for (const prompt of [extract, find]) {
      expect(prompt).toMatch(/as it would be bought/);
      expect(prompt).toMatch(/metric/);
      expect(prompt).toMatch(/cups, lb and oz/);
      expect(prompt).toContain('"preparationNote"');
    }
  });

  it("asks both prompts for the amount in quantity and unit, as the recipe states it, without scaling, and still a bare name", async () => {
    const { run, calls } = scriptedRunner(['[{"name": "mjölk"}]', '{"url": "https://x.example", "ingredients": []}']);
    const agent = new CliAgent("claude -p", { run });

    await agent.extractIngredients("page");
    await agent.findRecipe("Mos");

    for (const prompt of calls.map((c) => c.args.at(-1)!)) {
      expect(prompt).toMatch(/as it would be bought/);
      expect(prompt).not.toMatch(/no amounts/);
      expect(prompt).toMatch(/"quantity" and "unit"/);
      expect(prompt).toMatch(/as the recipe states it/);
      expect(prompt).toMatch(/do not scale/i);
    }
  });

  it("accepts a Preparation Note and rejects one that is not text", async () => {
    const { run } = scriptedRunner([
      '[{"name": "mjölk", "quantity": 2, "unit": "dl", "preparationNote": "till mos"}]',
      '[{"name": "mjölk", "preparationNote": 5}]',
      '[{"name": "mjölk", "preparationNote": 5}]',
    ]);
    const agent = new CliAgent("claude -p", { run });

    const ok = await agent.extractIngredients("page");
    const bad = await agent.extractIngredients("page");

    expect(ok).toEqual({ ok: true, value: [{ name: "mjölk", quantity: 2, unit: "dl", preparationNote: "till mos" }] });
    expect(bad.ok).toBe(false);
  });
});

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

  it("asks the agent to apply the Adaptation notes when given", async () => {
    const { run, calls } = scriptedRunner(['[{"name": "flour"}]', '[{"name": "flour"}]']);
    const agent = new CliAgent("copilot -p", { run });

    await agent.extractIngredients("page", { adaptationNotes: "no chili — the kids" });
    await agent.extractIngredients("page");

    expect(calls[0]!.args.at(-1)).toMatch(/apply these adaptations: no chili — the kids/);
    expect(calls[1]!.args.at(-1)).not.toMatch(/adaptation/i);
  });

  it("extracts the JSON from code fences and surrounding prose", async () => {
    const { run } = scriptedRunner([
      'Sure! Here is the list:\n```json\n[{"name": "eggs", "quantity": 6}]\n```\nLet me know if you need anything else.',
    ]);
    const agent = new CliAgent("claude -p", { run });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: true, value: [{ name: "eggs", quantity: 6 }] });
  });

  it("takes the last complete JSON value when leading text has brackets of its own", async () => {
    const { run } = scriptedRunner([
      'Fetched page [1] and {"note": "tool log"} first.\n[{"name": "eggs", "quantity": 6}]',
    ]);
    const agent = new CliAgent("claude -p", { run });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: true, value: [{ name: "eggs", quantity: 6 }] });
  });

  it("rejects output with leading text but no JSON", async () => {
    const { run } = scriptedRunner(["I fetched the page but found nothing.", "Still nothing."]);
    const agent = new CliAgent("claude -p", { run });

    const result = await agent.extractIngredients("page");

    expect(result.ok).toBe(false);
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
    const { logger, records } = createCapturingLogger();
    const agent = new CliAgent("copilot -p", { run, log: logger });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: false, reason: "invalid JSON after retry: still nope" });
    expect(calls).toHaveLength(2);
    expect(records.find((r) => r.level === "warn")).toMatchObject({
      operation: "extractIngredients",
      cause: "invalid-json",
      exitCode: 0,
      stdoutTail: "still nope",
    });
  });

  it("degrades when the agent process cannot be spawned", async () => {
    const run: ProcessRunner = async () => {
      throw Object.assign(new Error("spawn copilot EACCES"), { code: "EACCES" });
    };
    const { logger, records } = createCapturingLogger();
    const agent = new CliAgent("copilot -p", { run, log: logger });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: false, reason: "agent failed: spawn copilot EACCES" });
    expect(records.find((r) => r.level === "warn")).toMatchObject({ cause: "spawn-error", exitCode: null });
  });

  it("reports a missing agent binary as not found", async () => {
    const run: ProcessRunner = async () => {
      throw Object.assign(new Error("spawn copilot ENOENT"), { code: "ENOENT" });
    };
    const { logger, records } = createCapturingLogger();
    const agent = new CliAgent("copilot -p", { run, log: logger });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: false, reason: "agent binary not found: copilot" });
    expect(records.find((r) => r.level === "warn")).toMatchObject({ cause: "not-found", command: "copilot -p", exitCode: null });
  });

  it("reports a timed-out agent as a timeout, with what it printed so far", async () => {
    const run: ProcessRunner = async () => {
      throw new AgentTimeoutError(200, "partial", "thinking...");
    };
    const { logger, records } = createCapturingLogger();
    const agent = new CliAgent("copilot -p", { run, log: logger });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: false, reason: "agent timed out after 200ms" });
    expect(records.find((r) => r.level === "warn")).toMatchObject({
      cause: "timeout",
      exitCode: null,
      stdoutTail: "partial",
      stderrTail: "thinking...",
    });
  });

  it("keeps the stderr tail in the reason short and the warn tail at 8 KB", async () => {
    const stderr = "x".repeat(20_000) + "THE END";
    const run: ProcessRunner = async () => ({ stdout: "", stderr, exitCode: 3 });
    const { logger, records } = createCapturingLogger();
    const agent = new CliAgent("copilot -p", { run, log: logger });

    const result = await agent.extractIngredients("page");

    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason.startsWith("agent exited with code 3: ")).toBe(true);
    expect(reason.endsWith("THE END")).toBe(true);
    expect(reason.length).toBeLessThanOrEqual("agent exited with code 3: ".length + 500);
    const stderrTail = records.find((r) => r.level === "warn")!.stderrTail as string;
    expect(stderrTail.length).toBe(8192);
    expect(stderrTail.endsWith("THE END")).toBe(true);
  });

  it("degrades with the exit code and stderr tail when the agent exits non-zero", async () => {
    const run: ProcessRunner = async () => ({ stdout: "", stderr: "Error: not logged in. Run `copilot auth`.\n", exitCode: 1 });
    const { logger, records } = createCapturingLogger();
    const agent = new CliAgent("copilot -p", { run, log: logger });

    const result = await agent.extractIngredients("page");

    expect(result).toEqual({ ok: false, reason: "agent exited with code 1: Error: not logged in. Run `copilot auth`." });
    const warn = records.find((r) => r.level === "warn");
    expect(warn).toMatchObject({
      operation: "extractIngredients",
      command: "copilot -p",
      exitCode: 1,
      cause: "exit",
      stdoutTail: "",
      stderrTail: "Error: not logged in. Run `copilot auth`.\n",
    });
    expect(warn!.durationMs).toEqual(expect.any(Number));
  });
});

describe("CliAgent logging", () => {
  it("logs one info record per call with operation, duration, outcome and attempt", async () => {
    const { run } = scriptedRunner(["not json", '[{"name": "milk"}]', "nope", "nope"]);
    const { logger, records } = createCapturingLogger();
    const agent = new CliAgent("copilot -p", { run, log: logger });

    await agent.extractIngredients("page");
    await agent.findRecipe("Pannkakor");

    const infos = records.filter((r) => r.level === "info");
    expect(infos).toMatchObject([
      { operation: "extractIngredients", outcome: "ok", attempt: 2, durationMs: expect.any(Number) },
      { operation: "findRecipe", outcome: "degraded", attempt: 2, durationMs: expect.any(Number) },
    ]);
    expect(records.filter((r) => r.level === "warn")).toHaveLength(1);
  });

  it("logs the prompt and full output at debug only", async () => {
    const { run } = scriptedRunner(['[{"name": "milk"}]']);
    const { logger, records } = createCapturingLogger();
    const agent = new CliAgent("copilot -p", { run, log: logger });

    await agent.extractIngredients("<html>Pannkakor recipe</html>");

    const debug = records.filter((r) => r.level === "debug");
    expect(debug.some((r) => String(r.prompt).includes("Pannkakor recipe"))).toBe(true);
    expect(debug.some((r) => r.stdout === '[{"name": "milk"}]')).toBe(true);
    for (const r of records.filter((r) => r.level !== "debug")) {
      expect(JSON.stringify(r)).not.toContain("Pannkakor recipe");
      expect(r).not.toHaveProperty("stdout");
    }
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

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/^invalid JSON after retry: /) });
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

  it("asks the agent to apply the Adaptation notes when given", async () => {
    const reply = '{"url": "https://example.com/tacos", "ingredients": []}';
    const { run, calls } = scriptedRunner([reply, reply]);
    const agent = new CliAgent("copilot -p", { run });

    await agent.findRecipe("Tacos", { adaptationNotes: "no chili — the kids" });
    await agent.findRecipe("Tacos");

    expect(calls[0]!.args.at(-1)).toMatch(/apply these adaptations: no chili — the kids/);
    expect(calls[1]!.args.at(-1)).not.toMatch(/adaptation/i);
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

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/^invalid JSON after retry: /) });
  });
});

describe("CliAgent.suggestMainCategory", () => {
  const candidates = ["pasta", "fish", "other"] as const;

  it("returns the proposed category and names the dish and candidates in the prompt", async () => {
    const { run, calls } = scriptedRunner(['{"category": "fish"}']);
    const agent = new CliAgent("copilot -p", { run });

    const result = await agent.suggestMainCategory("Fiskgratäng", [...candidates]);

    expect(result).toEqual({ ok: true, value: "fish" });
    expect(calls[0]!.args.at(-1)).toContain("Fiskgratäng");
    expect(calls[0]!.args.at(-1)).toContain("pasta");
  });

  it("accepts null when nothing fits", async () => {
    const { run } = scriptedRunner(['{"category": null}']);

    expect(await new CliAgent("copilot -p", { run }).suggestMainCategory("Mystery", [...candidates])).toEqual({ ok: true, value: null });
  });

  it("rejects a category outside the candidates (retry, then degrade)", async () => {
    const bad = '{"category": "beef"}';
    const { run } = scriptedRunner([bad, bad]);

    expect(await new CliAgent("copilot -p", { run }).suggestMainCategory("Steak", [...candidates])).toEqual({
      ok: false,
      reason: expect.stringMatching(/^invalid JSON after retry: /),
    });
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
    recentlyPlanned: [{ dishId: "d1", name: "Tacos", lastDate: "2026-10-12" }],
    suggestionStyle: "Swedish home cooking",
    seedDishes: [{ name: "Köttbullar", mainCategory: "beef" as const, prepTimeMinutes: 40 }],
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
      suggestionStyle: "x",
      seedDishes: [],
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

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/^invalid JSON after retry: /) });
  });

  it.each([
    ["sv", "Swedish"],
    ["en", "English"],
  ] as const)("asks for rationales in the UI language (%s)", async (language, name) => {
    const { run, calls } = scriptedRunner(["[]"]);
    await new CliAgent("copilot -p", { run }).selectDishes({ ...input, language });

    expect(calls[0]!.args.at(-1)).toContain(`Write each rationale as one short sentence in ${name}`);
  });

  it("hands the suggestion style and seed list to the agent in the request JSON", async () => {
    const { run, calls } = scriptedRunner(["[]"]);
    await new CliAgent("copilot -p", { run }).selectDishes(input);

    const prompt = calls[0]!.args.at(-1)!;
    expect(prompt).toContain("Swedish home cooking");
    expect(prompt).toContain("Köttbullar");
  });

  it("states the hard rules a suggestion must pass", async () => {
    const { run, calls } = scriptedRunner(["[]"]);
    await new CliAgent("copilot -p", { run }).selectDishes(input);

    const prompt = calls[0]!.args.at(-1)!;
    expect(prompt).toMatch(/not the same Main Category or name as that day's lunch/);
    expect(prompt).toMatch(/quickDayLimitMinutes/);
    expect(prompt).toMatch(/Weekend Dish only on Saturday or Sunday/);
    expect(prompt).toMatch(/Once a Week/);
  });

  it("lists the existing Dishes by id and name and asks for an existing Dish's id instead of a twin", async () => {
    const { run, calls } = scriptedRunner(["[]"]);
    const existingDishes = [
      { id: "d1", name: "Tacos", kind: "favorite" as const },
      { id: "d9", name: "Ärtsoppa med pannkakor", kind: "suggested" as const },
    ];
    await new CliAgent("copilot -p", { run }).selectDishes({ ...input, existingDishes });

    const prompt = calls[0]!.args.at(-1)!;
    expect(prompt).toContain('"id": "d9"');
    expect(prompt).toContain('"name": "Ärtsoppa med pannkakor"');
    expect(prompt).toMatch(/same meal as one of existingDishes, return that Dish's id/);
    expect(prompt).toMatch(/kind "favorite"[^.]*rotation[^.]*kind "suggested"/);
  });

  it("asks to avoid the same Main Category on consecutive dinners, with a rationale when it can't", async () => {
    const { run, calls } = scriptedRunner(["[]"]);
    await new CliAgent("copilot -p", { run }).selectDishes(input);

    expect(calls[0]!.args.at(-1)).toMatch(/Avoid the same Main Category on consecutive dinners; when you don't, say why in the rationale/);
  });

  describe("with an empty-candidate day", () => {
    const emptyDay = {
      days: [
        { date: "2026-10-19", isQuickDay: false, lunch: [] },
        { date: "2026-10-20", isQuickDay: false, lunch: [] },
      ],
      candidates: [[{ id: "d1", name: "Tacos" }], []],
      recentlyPlanned: [],
      suggestionStyle: "Swedish home cooking",
      seedDishes: [],
    };

    it("accepts an existing Dish's id on a day with no candidates", async () => {
      const reply = [
        { date: "2026-10-19", dishId: "d1", rationale: "favorite" },
        { date: "2026-10-20", dishId: "9", rationale: "the soup we already have" },
      ];
      const { run } = scriptedRunner([JSON.stringify(reply)]);

      const result = await new CliAgent("copilot -p", { run }).selectDishes({
        ...emptyDay,
        existingDishes: [{ id: "9", name: "Ärtsoppa", kind: "suggested" }],
      });

      expect(result).toEqual({ ok: true, value: reply });
    });

    it("rejects an unknown Dish id on a day with no candidates", async () => {
      const bad = JSON.stringify([
        { date: "2026-10-19", dishId: "d1", rationale: "favorite" },
        { date: "2026-10-20", dishId: "42", rationale: "made up" },
      ]);
      const { run } = scriptedRunner([bad, bad]);

      const result = await new CliAgent("copilot -p", { run }).selectDishes({
        ...emptyDay,
        existingDishes: [{ id: "9", name: "Ärtsoppa", kind: "suggested" }],
      });

      expect(result).toMatchObject({ ok: false });
    });

    it("accepts a reply mixing a pick and a suggestion", async () => {
      const reply = [
        { date: "2026-10-19", dishId: "d1", rationale: "favorite" },
        { date: "2026-10-20", suggestion: { name: "Fiskgratäng", mainCategory: "fish", prepTimeMinutes: 45 }, rationale: "new" },
      ];
      const { run } = scriptedRunner([JSON.stringify(reply)]);

      const result = await new CliAgent("copilot -p", { run }).selectDishes(emptyDay);

      expect(result).toEqual({ ok: true, value: reply });
    });

    it("accepts a suggestion without a prep time", async () => {
      const reply = [
        { date: "2026-10-19", dishId: "d1", rationale: "favorite" },
        { date: "2026-10-20", suggestion: { name: "Soppa", mainCategory: "other" }, rationale: "new" },
      ];
      const { run } = scriptedRunner([JSON.stringify(reply)]);

      expect(await new CliAgent("copilot -p", { run }).selectDishes(emptyDay)).toEqual({ ok: true, value: reply });
    });

    it.each([
      ["an empty name", { name: "", mainCategory: "fish" }, { name: "", mainCategory: "fish" }],
      ["an unknown category", { name: "Sushi", mainCategory: "sushi" }, { name: "Sushi", mainCategory: "sushi" }],
      ["a missing category", { name: "Sushi" }, { name: "Sushi", mainCategory: "" }],
      ["a zero prep time", { name: "Soppa", mainCategory: "soup", prepTimeMinutes: 0 }, { name: "Soppa", mainCategory: "soup", prepTimeMinutes: 0 }],
      ["a string prep time", { name: "Soppa", mainCategory: "soup", prepTimeMinutes: "30" }, { name: "Soppa", mainCategory: "soup" }],
    ])("passes a suggestion with %s through for the planner to judge", async (_label, suggestion, expected) => {
      const reply = JSON.stringify([
        { date: "2026-10-19", dishId: "d1", rationale: "favorite" },
        { date: "2026-10-20", suggestion, rationale: "new" },
      ]);
      const { run, calls } = scriptedRunner([reply]);

      const result = await new CliAgent("copilot -p", { run }).selectDishes(emptyDay);

      expect(result).toEqual({
        ok: true,
        value: [
          { date: "2026-10-19", dishId: "d1", rationale: "favorite" },
          { date: "2026-10-20", suggestion: expected, rationale: "new" },
        ],
      });
      expect(calls).toHaveLength(1);
    });

    it("accepts a week of six good picks and one malformed suggestion", async () => {
      const dates = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
      const week = {
        days: dates.map((date) => ({ date, isQuickDay: false, lunch: [] })),
        candidates: dates.map((_, i) => (i === 6 ? [] : [{ id: "d1", name: "Tacos" }])),
        recentlyPlanned: [],
        suggestionStyle: "x",
        seedDishes: [],
      };
      const reply = [
        ...dates.slice(0, 6).map((date) => ({ date, dishId: "d1", rationale: "favorite" })),
        { date: "2026-10-25", suggestion: { name: "", mainCategory: "sushi" }, rationale: "new" },
      ];
      const { run } = scriptedRunner([JSON.stringify(reply)]);

      expect(await new CliAgent("copilot -p", { run }).selectDishes(week)).toEqual({ ok: true, value: reply });
    });

    it.each([
      ["no name", { mainCategory: "fish" }],
      ["a numeric name", { name: 7, mainCategory: "fish" }],
      ["a non-object suggestion", "Soppa"],
    ])("rejects a suggestion with %s as invalid JSON and retries once", async (_label, suggestion) => {
      const bad = JSON.stringify([
        { date: "2026-10-19", dishId: "d1", rationale: "favorite" },
        { date: "2026-10-20", suggestion, rationale: "new" },
      ]);
      const { run, calls } = scriptedRunner([bad, bad]);

      const result = await new CliAgent("copilot -p", { run }).selectDishes(emptyDay);

      expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/^invalid JSON after retry: /) });
      expect(calls).toHaveLength(2);
    });

    it("rejects a suggestion for a date that has candidates", async () => {
      const bad = JSON.stringify([
        { date: "2026-10-19", suggestion: { name: "Soppa", mainCategory: "soup" }, rationale: "x" },
        { date: "2026-10-20", suggestion: { name: "Soppa", mainCategory: "soup" }, rationale: "x" },
      ]);
      const { run } = scriptedRunner([bad, bad]);

      const result = await new CliAgent("copilot -p", { run }).selectDishes(emptyDay);

      expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/^invalid JSON after retry: /) });
    });
  });
});
