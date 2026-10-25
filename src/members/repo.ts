import type Database from "better-sqlite3";
import type { MemberColour } from "./palette.js";

export interface Member {
  id: number;
  name: string;
  colour: MemberColour;
  /** An ntfy topic of the Member's own, for their reminders; null for none. */
  topic: string | null;
  position: number;
}

export interface MemberInput {
  name: string;
  colour: MemberColour;
  topic?: string | null;
}

interface MemberRow {
  id: number;
  name: string;
  colour: MemberColour;
  topic: string | null;
  position: number;
}

const SELECT = "SELECT id, name, colour, topic, position FROM member";

export function listMembers(db: Database.Database): Member[] {
  return db.prepare(`${SELECT} ORDER BY position, id`).all() as MemberRow[];
}

export function getMember(db: Database.Database, id: number): Member | undefined {
  return (db.prepare(`${SELECT} WHERE id = ?`).get(id) as MemberRow | undefined) ?? undefined;
}

export function createMember(db: Database.Database, input: MemberInput): Member {
  const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM member").get() as { next: number }).next;
  const result = db.prepare("INSERT INTO member (name, colour, topic, position) VALUES (?, ?, ?, ?)").run(input.name.trim(), input.colour, input.topic?.trim() || null, position);
  return getMember(db, Number(result.lastInsertRowid))!;
}

export function updateMember(db: Database.Database, id: number, input: MemberInput): boolean {
  return db.prepare("UPDATE member SET name = ?, colour = ?, topic = ? WHERE id = ?").run(input.name.trim(), input.colour, input.topic?.trim() || null, id).changes > 0;
}

/** Deletes the Member. Attribution rows elsewhere keep the name as text (`member_name`), so nothing dangles. */
export function deleteMember(db: Database.Database, id: number): boolean {
  return db.prepare("DELETE FROM member WHERE id = ?").run(id).changes > 0;
}
