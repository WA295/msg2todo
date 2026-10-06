import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { events } from './events.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS todos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  due_at      TEXT,
  priority    TEXT DEFAULT 'medium',
  notes       TEXT DEFAULT '',
  source      TEXT DEFAULT 'manual',
  chat_name   TEXT DEFAULT '',
  sender_name TEXT DEFAULT '',
  status      TEXT DEFAULT 'open',
  created_at  TEXT NOT NULL,
  done_at     TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  platform   TEXT,
  chat_id    TEXT,
  chat_name  TEXT,
  sender     TEXT,
  text       TEXT,
  created_at TEXT NOT NULL
);
`);

const insTodo = db.prepare(`
  INSERT INTO todos (title, due_at, priority, notes, source, chat_name, sender_name, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
`);
const getTodoStmt = db.prepare('SELECT * FROM todos WHERE id = ?');

// 迁移:notified_at 用于到期推送去重,notified_adv_at 用于提前提醒去重
const todoCols = db.prepare('PRAGMA table_info(todos)').all().map((c) => c.name);
if (!todoCols.includes('notified_at')) {
  db.exec('ALTER TABLE todos ADD COLUMN notified_at TEXT');
}
if (!todoCols.includes('notified_adv_at')) {
  db.exec('ALTER TABLE todos ADD COLUMN notified_adv_at TEXT');
}

export function addTodo({ title, dueAt = null, priority = 'medium', notes = '', source = 'manual', chatName = '', senderName = '' }) {
  const now = new Date().toISOString();
  const r = insTodo.run(title, dueAt, priority, notes, source, chatName, senderName, now);
  events.emit('change');
  return getTodoStmt.get(Number(r.lastInsertRowid));
}

export function listTodos({ status = 'all', q = '' } = {}) {
  const conds = [];
  const args = [];
  if (status === 'open') conds.push("status = 'open'");
  if (status === 'done') conds.push("status = 'done'");
  if (q) {
    conds.push('(title LIKE ? OR notes LIKE ? OR sender_name LIKE ? OR chat_name LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM todos ${where}
       ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
                CASE WHEN status='open' THEN 0 ELSE 1 END,
                due_at ASC, id DESC`
    )
    .all(...args);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export function toggleTodo(id) {
  const todo = getTodoStmt.get(id);
  if (!todo) return null;
  if (todo.status === 'done') {
    db.prepare("UPDATE todos SET status='open', done_at=NULL WHERE id=?").run(id);
  } else {
    db.prepare("UPDATE todos SET status='done', done_at=? WHERE id=?").run(new Date().toISOString(), id);
  }
  events.emit('change');
  return getTodoStmt.get(id);
}

export function deleteTodo(id) {
  const r = db.prepare('DELETE FROM todos WHERE id = ?').run(id);
  if (r.changes > 0) events.emit('change');
  return r.changes > 0;
}

export function addMessage({ platform, chatId, chatName, sender, text }) {
  db.prepare('INSERT INTO messages (platform, chat_id, chat_name, sender, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(platform, chatId, chatName, sender, text, new Date().toISOString());
}

export function stats() {
  const row = db
    .prepare("SELECT SUM(status='open') AS open, SUM(status='done') AS done, COUNT(*) AS total FROM todos")
    .get();
  return { open: Number(row.open || 0), done: Number(row.done || 0), total: Number(row.total || 0) };
}
