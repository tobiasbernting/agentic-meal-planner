import { describe, expect, it } from "vitest";
import { exampleJsonPlugin } from "./example-json.js";

const MENU = JSON.stringify({
  days: [
    { date: "2026-10-19", dishes: ["Pasta bolognese"] },
    { date: "2026-10-20", dishes: ["Fiskgratäng", "Vegetarisk lasagne"] },
    { date: "2026-10-26", dishes: ["Next week's soup"] },
  ],
});

describe("example JSON School Plugin", () => {
  it("claims only URLs ending in .lunch.json", () => {
    const plugin = exampleJsonPlugin(async () => MENU);

    expect(plugin.claims("https://school.example/menu.lunch.json")).toBe(true);
    expect(plugin.claims("https://school.example/menu.html")).toBe(false);
  });

  it("returns one Lunch Entry per date of the requested week, dishes joined by newline", async () => {
    const fetched: string[] = [];
    const plugin = exampleJsonPlugin(async (url) => {
      fetched.push(url);
      return MENU;
    });

    const entries = await plugin.scrape("https://school.example/menu.lunch.json", "2026-10-19");

    expect(fetched).toEqual(["https://school.example/menu.lunch.json"]);
    expect(entries).toEqual([
      { date: "2026-10-19", rawText: "Pasta bolognese" },
      { date: "2026-10-20", rawText: "Fiskgratäng\nVegetarisk lasagne" },
    ]);
  });

  it("returns no entries for a page that is not the expected JSON", async () => {
    const plugin = exampleJsonPlugin(async () => "<html>not json</html>");

    await expect(plugin.scrape("https://school.example/menu.lunch.json", "2026-10-19")).resolves.toEqual([]);
  });
});
