import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";

describe("openDatabase", () => {
  it("creates the SQLite file inside the data directory", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mp-db-"));

    const db = openDatabase(dataDir);
    db.close();

    expect(existsSync(join(dataDir, "meal-planner.db"))).toBe(true);
  });

  it("keeps its data after the database is closed and reopened", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mp-db-"));

    const first = openDatabase(dataDir);
    const createdAt = first.prepare("SELECT value FROM meta WHERE key = 'created_at'").get() as { value: string };
    first.close();

    const second = openDatabase(dataDir);
    const reopened = second.prepare("SELECT value FROM meta WHERE key = 'created_at'").get() as { value: string };
    second.close();

    expect(reopened.value).toBe(createdAt.value);
  });
});
