import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { langOf, t, weekdayName } from "./index.js";
import { en } from "./en.js";
import { sv } from "./sv.js";

describe("t", () => {
  it("translates and fills params", () => {
    expect(t("sv", "dishes.title")).toBe("Rätter");
    expect(t("en", "dishes.title")).toBe("Dishes");
    expect(t("sv", "dishes.prepMinutes", { n: 20 })).toBe("20 min");
  });

  it("has the same keys in both languages and no empty text", () => {
    expect(Object.keys(sv).sort()).toEqual(Object.keys(en).sort());
    for (const text of Object.values(sv)) expect(text).not.toBe("");
  });

  it("localises weekdays", () => {
    expect(weekdayName("sv", "mon")).toBe("Måndag");
    expect(weekdayName("en", "sun", "short")).toBe("Sun");
  });
});

describe("langOf", () => {
  it("defaults to Swedish", () => {
    expect(langOf({ headers: {} })).toBe("sv");
  });
  it("reads the lang cookie", () => {
    expect(langOf({ headers: { cookie: "a=b; lang=en" } })).toBe("en");
  });
  it("ignores unknown languages", () => {
    expect(langOf({ headers: { cookie: "lang=de" } })).toBe("sv");
  });
});

describe("request language", () => {
  it("renders English with the lang=en cookie and Swedish without", async () => {
    const app = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), "i18n-")) });
    const sw = await app.inject({ url: "/dishes" });
    expect(sw.body).toContain('<html lang="sv">');
    const english = await app.inject({ url: "/dishes", headers: { cookie: "lang=en" } });
    expect(english.body).toContain('<html lang="en">');
    expect(english.body).toContain("<h1>Dishes</h1>");
    await app.close();
  });
});
