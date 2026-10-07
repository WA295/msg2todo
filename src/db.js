import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { events } from './events.js';
import { partsOf } from './time.js';

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
CREATE TABLE IF NOT EXISTS schedule_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner      TEXT NOT NULL,            -- 'qq:<user_id>'
  day        INTEGER NOT NULL,         -- 0=周日 ~ 6=周六
  start_min  INTEGER NOT NULL,         -- 距 00:00 的分钟数
  end_min    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  location   TEXT DEFAULT '',
  week_start INTEGER,                  -- null = 每周
  week_end   INTEGER,
  parity     TEXT DEFAULT '',          -- '' | 'odd'(单周) | 'even'(双周)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_items_owner ON schedule_items(owner);
CREATE TABLE IF NOT EXISTS schedule_users (
  owner          TEXT PRIMARY KEY,     -- 'qq:<user_id>'
  name           TEXT DEFAULT '',
  semester_start TEXT,                 -- 'YYYY-MM-DD' 开学第一周
  notify_time    TEXT,                 -- 'HH:MM' 个人提醒时间,空=用全局
  push_kind      TEXT DEFAULT '',      -- '' | 'bark' | 'pushdeer'
  push_key       TEXT DEFAULT '',
  last_remind    TEXT,                 -- 'YYYY-MM-DD' 已提醒过的"明天"日期(去重)
  updated_at     TEXT
);
CREATE TABLE IF NOT EXISTS pomodoro (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner         TEXT NOT NULL,         -- 'qq:<user_id>'
  focus_min     INTEGER NOT NULL,      -- 专注时长(分钟)
  rest_min      INTEGER NOT NULL,      -- 休息时长(分钟)
  rounds        INTEGER NOT NULL DEFAULT 1,  -- 总轮数
  round         INTEGER NOT NULL DEFAULT 1,  -- 当前轮
  phase         TEXT NOT NULL DEFAULT 'focus', -- focus | rest
  phase_started TEXT NOT NULL,         -- 本阶段开始时间 ISO
  status        TEXT NOT NULL DEFAULT 'running', -- running | done | cancelled
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pomodoro_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner       TEXT NOT NULL,
  focus_min   INTEGER NOT NULL,
  day         TEXT NOT NULL,           -- 'YYYY-MM-DD'(配置时区,统计用)
  finished_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS weather_users (
  owner              TEXT PRIMARY KEY,  -- 'qq:<user_id>'
  city               TEXT DEFAULT '',   -- 城市名,空=用全局 WEATHER_CITY
  notify_time        TEXT,              -- 'HH:MM' 个人推送时间,空=用全局
  enabled            INTEGER DEFAULT 1, -- 0 = 已关闭天气推送
  last_weather_remind TEXT,             -- 'YYYY-MM-DD' 去重
  updated_at         TEXT
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

/* ================= 课表 ================= */

const getScheduleUserStmt = db.prepare('SELECT * FROM schedule_users WHERE owner = ?');
const insScheduleItem = db.prepare(`
  INSERT INTO schedule_items (owner, day, start_min, end_min, name, location, week_start, week_end, parity, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function getScheduleUser(owner) {
  return getScheduleUserStmt.get(owner) || null;
}

/** 创建或更新学生信息;字段传 null 表示不修改 */
export function upsertScheduleUser(owner, fields) {
  const now = new Date().toISOString();
  const cur = getScheduleUser(owner);
  if (!cur) {
    db.prepare(`
      INSERT INTO schedule_users (owner, name, semester_start, notify_time, push_kind, push_key, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      owner,
      fields.name || '',
      fields.semesterStart ?? '',
      fields.notifyTime ?? '',
      fields.pushKind ?? '',
      fields.pushKey ?? '',
      now
    );
  } else {
    db.prepare(`
      UPDATE schedule_users SET
        name = COALESCE(?, name),
        semester_start = COALESCE(?, semester_start),
        notify_time = COALESCE(?, notify_time),
        push_kind = COALESCE(?, push_kind),
        push_key = COALESCE(?, push_key),
        updated_at = ?
      WHERE owner = ?
    `).run(
      fields.name ?? null,
      fields.semesterStart ?? null,
      fields.notifyTime ?? null,
      fields.pushKind ?? null,
      fields.pushKey ?? null,
      now,
      owner
    );
  }
  events.emit('change');
  return getScheduleUser(owner);
}

function insertScheduleItems(owner, items) {
  const now = new Date().toISOString();
  for (const it of items) {
    insScheduleItem.run(owner, it.day, it.startMin, it.endMin, it.name, it.location || '', it.weekStart ?? null, it.weekEnd ?? null, it.parity || '', now);
  }
}

/** 整体覆盖课表 */
export function replaceSchedule(owner, items) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM schedule_items WHERE owner = ?').run(owner);
    insertScheduleItems(owner, items);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  events.emit('change');
}

/** 追加课程 */
export function addScheduleItems(owner, items) {
  insertScheduleItems(owner, items);
  events.emit('change');
}

export function listScheduleItems(owner) {
  return db
    .prepare('SELECT * FROM schedule_items WHERE owner = ? ORDER BY day, start_min, id')
    .all(owner)
    .map((r) => ({ ...r, id: Number(r.id) }));
}

export function clearSchedule(owner) {
  const r = db.prepare('DELETE FROM schedule_items WHERE owner = ?').run(owner);
  if (r.changes > 0) events.emit('change');
  return r.changes > 0;
}

export function deleteScheduleItem(id) {
  const r = db.prepare('DELETE FROM schedule_items WHERE id = ?').run(id);
  if (r.changes > 0) events.emit('change');
  return r.changes > 0;
}

export function listScheduleUsers() {
  return db.prepare('SELECT * FROM schedule_users ORDER BY updated_at DESC').all();
}

/* ================= 番茄钟 ================= */

/** 开始新的番茄钟(自动取消进行中的) */
export function startPomodoro({ owner, focusMin, restMin, rounds }) {
  const now = new Date().toISOString();
  db.prepare("UPDATE pomodoro SET status='cancelled' WHERE owner = ? AND status = 'running'").run(owner);
  const r = db
    .prepare(`
      INSERT INTO pomodoro (owner, focus_min, rest_min, rounds, round, phase, phase_started, status, created_at)
      VALUES (?, ?, ?, ?, 1, 'focus', ?, 'running', ?)
    `)
    .run(owner, focusMin, restMin, rounds, now, now);
  events.emit('change');
  return Number(r.lastInsertRowid);
}

export function getRunningPomodoro(owner) {
  return db.prepare("SELECT * FROM pomodoro WHERE owner = ? AND status = 'running'").get(owner) || null;
}

export function stopPomodoro(owner) {
  const r = db.prepare("UPDATE pomodoro SET status = 'cancelled' WHERE owner = ? AND status = 'running'").run(owner);
  if (r.changes > 0) events.emit('change');
  return r.changes > 0;
}

/** 把某轮设为新阶段(rest/focus 切换) */
export function setPomodoroPhase(id, { phase, round, phaseStarted }) {
  db.prepare('UPDATE pomodoro SET phase = ?, round = ?, phase_started = ? WHERE id = ?')
    .run(phase, round, phaseStarted, id);
  events.emit('change');
}

export function finishPomodoro(id) {
  db.prepare("UPDATE pomodoro SET status = 'done' WHERE id = ?").run(id);
  events.emit('change');
}

export function logPomodoro({ owner, focusMin }) {
  const p = partsOf(new Date());
  const day = `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  db.prepare('INSERT INTO pomodoro_log (owner, focus_min, day, finished_at) VALUES (?, ?, ?, ?)')
    .run(owner, focusMin, day, new Date().toISOString());
}

function todayStr() {
  const p = partsOf(new Date());
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** 某人的番茄统计 */
export function pomodoroStats(owner) {
  const day = todayStr();
  const today = db.prepare('SELECT COUNT(*) c FROM pomodoro_log WHERE owner = ? AND day = ?').get(owner, day).c;
  const total = db.prepare('SELECT COUNT(*) c FROM pomodoro_log WHERE owner = ?').get(owner).c;
  const focusMinutes = db.prepare('SELECT COALESCE(SUM(focus_min),0) m FROM pomodoro_log WHERE owner = ?').get(owner).m;
  return { today: Number(today), total: Number(total), focusMinutes: Number(focusMinutes) };
}

/** 全部用户今天的番茄数(看板用) */
export function pomodoroTodayByOwner() {
  const rows = db.prepare('SELECT owner, COUNT(*) c FROM pomodoro_log WHERE day = ? GROUP BY owner').all(todayStr());
  const map = {};
  for (const r of rows) map[r.owner] = Number(r.c);
  return map;
}

/* ================= 天气 ================= */

const getWeatherUserStmt = db.prepare('SELECT * FROM weather_users WHERE owner = ?');

export function getWeatherUser(owner) {
  return getWeatherUserStmt.get(owner) || null;
}

/** 更新天气订阅;字段传 null 表示不修改 */
export function upsertWeatherUser(owner, fields) {
  const now = new Date().toISOString();
  const cur = getWeatherUser(owner);
  if (!cur) {
    db.prepare(`
      INSERT INTO weather_users (owner, city, notify_time, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(owner, fields.city ?? '', fields.notifyTime ?? '', fields.enabled ?? 1, now);
  } else {
    db.prepare(`
      UPDATE weather_users SET
        city = COALESCE(?, city),
        notify_time = COALESCE(?, notify_time),
        enabled = COALESCE(?, enabled),
        updated_at = ?
      WHERE owner = ?
    `).run(fields.city ?? null, fields.notifyTime ?? null, fields.enabled ?? null, now, owner);
  }
  events.emit('change');
  return getWeatherUser(owner);
}

export function setWeatherReminded(owner, day) {
  const cur = getWeatherUser(owner);
  if (cur) {
    db.prepare('UPDATE weather_users SET last_weather_remind = ? WHERE owner = ?').run(day, owner);
  } else {
    db.prepare(`
      INSERT INTO weather_users (owner, city, notify_time, enabled, last_weather_remind, updated_at)
      VALUES (?, '', '', 1, ?, ?)
    `).run(owner, day, new Date().toISOString());
  }
}

export function listWeatherUsers() {
  return db.prepare('SELECT * FROM weather_users ORDER BY updated_at DESC').all();
}
