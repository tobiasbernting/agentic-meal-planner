/**
 * Todos (ADR-0010): the items of a todo-style List, stored in `list_item` with the Todo columns
 * src/db.ts adds. Done is a state (`checked_at`), struck and sorted last, until Cleared; a
 * repeating Todo instead advances its Due on tick and writes a done record (src/lists/repeat.ts).
 */
import type Database from "better-sqlite3";
import { normaliseName } from "../text.js";
import { getList } from "./repo.js";
import { nextDue, parseRepeat, type RepeatRule } from "./repeat.js";

export interface Todo {
  id: number;
  listId: number;
  title: string;
  notes: string | null;
  dueDate: string | null;
  dueTime: string | null;
  memberId: number | null;
  memberName: string | null;
  repeat: RepeatRule | null;
  addedBy: string | null;
  createdAt: string;
  doneAt: string | null;
  doneBy: string | null;
  position: number;
}

export interface TodoInput {
  title: string;
  notes?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  member?: { id: number; name: string } | null;
  repeat?: RepeatRule | null;
}

interface TodoRow {
  id: number;
  list_id: number;
  name: string;
  notes: string | null;
  due_date: string | null;
  due_time: string | null;
  member_id: number | null;
  member_name: string | null;
  repeat: string | null;
  added_by: string | null;
  created_at: string;
  checked_at: string | null;
  checked_by: string | null;
  position: number;
}

const SELECT = "SELECT id, list_id, name, notes, due_date, due_time, member_id, member_name, repeat, added_by, created_at, checked_at, checked_by, position FROM list_item";

function toTodo(r: TodoRow): Todo {
  return {
    id: r.id,
    listId: r.list_id,
    title: r.name,
    notes: r.notes,
    dueDate: r.due_date,
    dueTime: r.due_time,
    memberId: r.member_id,
    memberName: r.member_name,
    repeat: parseRepeat(r.repeat),
    addedBy: r.added_by,
    createdAt: r.created_at,
    doneAt: r.checked_at,
    doneBy: r.checked_by,
    position: r.position,
  };
}

export function getTodo(db: Database.Database, id: number): Todo | undefined {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as TodoRow | undefined;
  return row && getList(db, row.list_id)?.kind === "todo" ? toTodo(row) : undefined;
}

/** Open Todos by Due (undated last), then position; Done ones after, most recently done first. */
export function listTodos(db: Database.Database, listId: number): Todo[] {
  const rows = db
    .prepare(
      `${SELECT} WHERE list_id = ?
       ORDER BY checked_at IS NOT NULL, CASE WHEN checked_at IS NULL THEN due_date IS NULL ELSE 0 END, CASE WHEN checked_at IS NULL THEN due_date END, CASE WHEN checked_at IS NULL THEN due_time END, checked_at DESC, position, id`,
    )
    .all(listId) as TodoRow[];
  return rows.map(toTodo);
}

/** Open Todos due on `date`, across every todo-style List, by time then position. */
export function listTodosDue(db: Database.Database, date: string): Todo[] {
  const rows = db
    .prepare(`${SELECT} WHERE due_date = ? AND checked_at IS NULL AND list_id IN (SELECT id FROM list WHERE kind = 'todo') ORDER BY due_time IS NULL, due_time, position, id`)
    .all(date) as TodoRow[];
  return rows.map(toTodo);
}

/** Open Todos due from `from` to `to` (inclusive), across every todo-style List, by date, time then position. */
export function listTodosDueBetween(db: Database.Database, from: string, to: string): Todo[] {
  const rows = db
    .prepare(`${SELECT} WHERE due_date BETWEEN ? AND ? AND checked_at IS NULL AND list_id IN (SELECT id FROM list WHERE kind = 'todo') ORDER BY due_date, due_time IS NULL, due_time, position, id`)
    .all(from, to) as TodoRow[];
  return rows.map(toTodo);
}

/** Open Todos whose Due date is before `today`, oldest first. */
export function listOverdueTodos(db: Database.Database, today: string): Todo[] {
  const rows = db
    .prepare(`${SELECT} WHERE due_date < ? AND checked_at IS NULL AND list_id IN (SELECT id FROM list WHERE kind = 'todo') ORDER BY due_date, due_time IS NULL, due_time, position, id`)
    .all(today) as TodoRow[];
  return rows.map(toTodo);
}

export function countOpenTodos(db: Database.Database, listId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM list_item WHERE list_id = ? AND checked_at IS NULL").get(listId) as { n: number }).n;
}

export function createTodo(db: Database.Database, listId: number, input: TodoInput, now: string, addedBy: string | null): Todo {
  const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM list_item WHERE list_id = ?").get(listId) as { next: number }).next;
  const result = db
    .prepare(
      `INSERT INTO list_item (list_id, name, name_key, notes, due_date, due_time, member_id, member_name, repeat, added_by, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      listId,
      input.title.trim(),
      // Todos may repeat a title; the key is made unique per row so the Shopping List's name index does not bite.
      `todo:${position}:${normaliseName(input.title)}:${now}`,
      input.notes?.trim() || null,
      input.dueDate ?? null,
      input.dueTime ?? null,
      input.member?.id ?? null,
      input.member?.name ?? null,
      input.repeat ? JSON.stringify(input.repeat) : null,
      addedBy,
      position,
      now,
    );
  return getTodo(db, Number(result.lastInsertRowid))!;
}

export function updateTodo(db: Database.Database, id: number, input: TodoInput): boolean {
  return (
    db
      .prepare("UPDATE list_item SET name = ?, notes = ?, due_date = ?, due_time = ?, member_id = ?, member_name = ?, repeat = ? WHERE id = ?")
      .run(input.title.trim(), input.notes?.trim() || null, input.dueDate ?? null, input.dueTime ?? null, input.member?.id ?? null, input.member?.name ?? null, input.repeat ? JSON.stringify(input.repeat) : null, id).changes > 0
  );
}

export function deleteTodo(db: Database.Database, id: number): boolean {
  return db.prepare("DELETE FROM list_item WHERE id = ?").run(id).changes > 0;
}

export type TickOutcome = { kind: "done" } | { kind: "advanced"; nextDue: string } | { kind: "missing" };

/**
 * Ticks a Todo. A plain Todo becomes Done (struck, attributed). A repeating Todo writes a done
 * record and moves to its next Due instead; with no Due yet, the rule anchors on `today`.
 */
export function tickTodo(db: Database.Database, id: number, now: string, today: string, by: { id: number; name: string } | undefined): TickOutcome {
  const todo = getTodo(db, id);
  if (!todo) return { kind: "missing" };
  if (todo.repeat) {
    const next = nextDue(todo.repeat, todo.dueDate ?? today);
    db.transaction(() => {
      db.prepare("INSERT INTO list_item_done (list_item_id, done_at, member_id, member_name) VALUES (?, ?, ?, ?)").run(id, now, by?.id ?? null, by?.name ?? null);
      db.prepare("UPDATE list_item SET due_date = ?, checked_at = NULL, checked_by = NULL, reminded_at = NULL WHERE id = ?").run(next, id);
    })();
    return { kind: "advanced", nextDue: next };
  }
  db.prepare("UPDATE list_item SET checked_at = ?, checked_by = ? WHERE id = ?").run(now, by?.name ?? null, id);
  return { kind: "done" };
}

/** Un-ticks a Done Todo; refused (false) for a repeating one, which has already moved on. */
export function untickTodo(db: Database.Database, id: number): boolean {
  const todo = getTodo(db, id);
  if (!todo || todo.repeat) return false;
  db.prepare("UPDATE list_item SET checked_at = NULL, checked_by = NULL WHERE id = ?").run(id);
  return true;
}

export function endRepeat(db: Database.Database, id: number): boolean {
  return db.prepare("UPDATE list_item SET repeat = NULL WHERE id = ?").run(id).changes > 0;
}

export interface DoneRecord {
  doneAt: string;
  memberName: string | null;
}

/** The last done records of a repeating Todo, newest first. */
export function listDoneRecords(db: Database.Database, id: number, limit = 10): DoneRecord[] {
  const rows = db.prepare("SELECT done_at, member_name FROM list_item_done WHERE list_item_id = ? ORDER BY done_at DESC, id DESC LIMIT ?").all(id, limit) as { done_at: string; member_name: string | null }[];
  return rows.map((r) => ({ doneAt: r.done_at, memberName: r.member_name }));
}

/** Clear on a todo-style List: every Done Todo goes. Returns how many. */
export function clearDoneTodos(db: Database.Database, listId: number): number {
  return db.prepare("DELETE FROM list_item WHERE list_id = ? AND checked_at IS NOT NULL").run(listId).changes;
}
