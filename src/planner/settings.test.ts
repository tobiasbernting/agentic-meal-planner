import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, writeSetting } from "../db.js";
import {
  SETTING_CATEGORY_COLLISION_ENABLED,
  SETTING_DEFAULT_PREP_LIMIT_MINUTES,
  SETTING_QUICK_DAY_OVERRIDES,
  SETTING_QUICK_DAY_TEMPLATE,
  SETTING_SUGGESTION_STYLE,
  DEFAULT_SUGGESTION_STYLE,
  SETTING_VARIETY_WINDOW_WEEKS,
  quickDayLimitFor,
  readPlannerSettings,
} from "./settings.js";

function freshDb() {
  return openDatabase(mkdtempSync(join(tmpdir(), "planner-settings-")));
}

describe("readPlannerSettings", () => {
  it("uses the documented defaults when nothing is stored", () => {
    const settings = readPlannerSettings(freshDb());

    expect(settings).toEqual({
      varietyWindowWeeks: 3,
      categoryCollisionEnabled: true,
      quickDayTemplate: { tue: 30 },
      quickDayOverrides: {},
      defaultPrepLimitMinutes: 30,
      suggestionStyle: DEFAULT_SUGGESTION_STYLE,
    });
  });

  it("reads the saved suggestion style, and treats blank as the default", () => {
    const db = freshDb();
    writeSetting(db, SETTING_SUGGESTION_STYLE, "vegetarian Indian");
    expect(readPlannerSettings(db).suggestionStyle).toBe("vegetarian Indian");
    writeSetting(db, SETTING_SUGGESTION_STYLE, "   ");
    expect(readPlannerSettings(db).suggestionStyle).toBe(DEFAULT_SUGGESTION_STYLE);
  });

  it("reads stored values", () => {
    const db = freshDb();
    writeSetting(db, SETTING_VARIETY_WINDOW_WEEKS, "5");
    writeSetting(db, SETTING_CATEGORY_COLLISION_ENABLED, "false");
    writeSetting(db, SETTING_QUICK_DAY_TEMPLATE, '{"tue":20,"thu":45}');
    writeSetting(db, SETTING_QUICK_DAY_OVERRIDES, '{"2026-10-12":{"tue":null,"fri":25}}');
    writeSetting(db, SETTING_DEFAULT_PREP_LIMIT_MINUTES, "40");

    expect(readPlannerSettings(db)).toEqual({
      varietyWindowWeeks: 5,
      categoryCollisionEnabled: false,
      quickDayTemplate: { tue: 20, thu: 45 },
      quickDayOverrides: { "2026-10-12": { tue: null, fri: 25 } },
      defaultPrepLimitMinutes: 40,
    });
  });

  it("falls back to defaults on malformed values", () => {
    const db = freshDb();
    writeSetting(db, SETTING_VARIETY_WINDOW_WEEKS, "lots");
    writeSetting(db, SETTING_QUICK_DAY_TEMPLATE, "{not json");

    const settings = readPlannerSettings(db);

    expect(settings.varietyWindowWeeks).toBe(3);
    expect(settings.quickDayTemplate).toEqual({ tue: 30 });
  });
});

describe("quickDayLimitFor", () => {
  const settings = {
    varietyWindowWeeks: 3,
    categoryCollisionEnabled: true,
    quickDayTemplate: { tue: 30, thu: 0 },
    quickDayOverrides: { "2026-10-12": { tue: null, fri: 20 } },
    defaultPrepLimitMinutes: 45,
  };

  it("is null on a day that is neither in the template nor overridden", () => {
    expect(quickDayLimitFor(settings, "2026-10-12", "mon")).toBeNull();
  });

  it("uses the template limit", () => {
    expect(quickDayLimitFor(settings, "2026-10-05", "tue")).toBe(30);
  });

  it("falls back to default_prep_limit_minutes when the template gives no usable limit", () => {
    expect(quickDayLimitFor(settings, "2026-10-05", "thu")).toBe(45);
  });

  it("a per-week override of null cancels the Quick Day for that week only", () => {
    expect(quickDayLimitFor(settings, "2026-10-12", "tue")).toBeNull();
    expect(quickDayLimitFor(settings, "2026-10-19", "tue")).toBe(30);
  });

  it("a per-week override can add a Quick Day with its own limit", () => {
    expect(quickDayLimitFor(settings, "2026-10-12", "fri")).toBe(20);
  });
});
