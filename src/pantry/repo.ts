import type Database from "better-sqlite3";

export interface PantryItem {
  id: number;
  name: string;
  /** Alternative names (e.g. the Swedish word) an Ingredient may use for this item. */
  aliases: string[];
}

export interface PantryItemInput {
  name: string;
  aliases: string[];
}

interface PantryRow {
  id: number;
  name: string;
  aliases: string;
}

const SELECT = "SELECT id, name, aliases FROM pantry_item";

/** Aliases are stored comma-separated (DESIGN.md `pantry_item`); blanks are dropped. */
export function parseAliases(text: string): string[] {
  return text
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

function toPantryItem(row: PantryRow): PantryItem {
  return { id: row.id, name: row.name, aliases: parseAliases(row.aliases) };
}

function serialiseAliases(aliases: string[]): string {
  return parseAliases(aliases.join(",")).join(",");
}

export function createPantryItem(db: Database.Database, input: PantryItemInput): PantryItem {
  const result = db
    .prepare("INSERT INTO pantry_item (name, aliases) VALUES (?, ?)")
    .run(input.name, serialiseAliases(input.aliases));
  return getPantryItem(db, Number(result.lastInsertRowid))!;
}

export function getPantryItem(db: Database.Database, id: number): PantryItem | undefined {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as PantryRow | undefined;
  return row ? toPantryItem(row) : undefined;
}

export function listPantryItems(db: Database.Database): PantryItem[] {
  return (db.prepare(`${SELECT} ORDER BY id`).all() as PantryRow[]).map(toPantryItem);
}

export function updatePantryItem(db: Database.Database, id: number, input: PantryItemInput): void {
  db.prepare("UPDATE pantry_item SET name = ?, aliases = ? WHERE id = ?").run(
    input.name,
    serialiseAliases(input.aliases),
    id,
  );
}

export function deletePantryItem(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM pantry_item WHERE id = ?").run(id);
}
