import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DB_FILENAME, openDatabase, readSetting } from "./db.js";

function tempDataDir() {
  return mkdtempSync(join(tmpdir(), "mp-db-"));
}

describe("openDatabase", () => {
  it("creates the SQLite file inside the data directory", () => {
    const dataDir = tempDataDir();

    const db = openDatabase(dataDir);
    db.close();

    expect(existsSync(join(dataDir, DB_FILENAME))).toBe(true);
  });

  it("keeps its data after the database is closed and reopened", () => {
    const dataDir = tempDataDir();

    const first = openDatabase(dataDir);
    const createdAt = readSetting(first, "created_at");
    first.close();

    const second = openDatabase(dataDir);
    const reopened = readSetting(second, "created_at");
    second.close();

    expect(createdAt).toBeDefined();
    expect(reopened).toBe(createdAt);
  });
});
