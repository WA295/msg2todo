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
CREATE TABLE IF NOT EXISTS countdowns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner      TEXT NOT NULL,             -- 'qq:<user_id>'
  title      TEXT NOT NULL,
  target     TEXT NOT NULL,             -- 'YYYY-MM-DD'
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_log (
  owner    TEXT NOT NULL,
  week     TEXT NOT NULL,               -- 周一的 'YYYY-MM-DD'(去重)
  sent_at  TEXT NOT NULL,
  PRIMARY KEY (owner, week)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner      TEXT NOT NULL,             -- 'qq:<user_id>' 或 'admin'
  endpoint    TEXT NOT NULL UNIQUE,      -- Web Push endpoint
  keys       TEXT NOT NULL,              -- JSON {p256dh, auth}
  user_agent TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort        INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS packages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner      TEXT NOT NULL,
  code       TEXT NOT NULL,              -- 取件码
  location   TEXT DEFAULT '',            -- 驿站/柜子
  company    TEXT DEFAULT '',            -- 快递公司
  status     TEXT DEFAULT 'pending',     -- pending | done
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner      TEXT NOT NULL,
  name       TEXT DEFAULT '',
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

// 迁移:todos(notified_at 去重 / notified_adv_at 提前提醒去重 / owner 多用户归属)
const todoCols = db.prepare('PRAGMA table_info(todos)').all().map((c) => c.name);
if (!todoCols.includes('notified_at')) {
  db.exec('ALTER TABLE todos ADD COLUMN notified_at TEXT');
}
if (!todoCols.includes('notified_adv_at')) {
  db.exec('ALTER TABLE todos ADD COLUMN notified_adv_at TEXT');
}
if (!todoCols.includes('owner')) {
  db.exec("ALTER TABLE todos ADD COLUMN owner TEXT DEFAULT ''");
}

const insTodo = db.prepare(`
  INSERT INTO todos (title, due_at, priority, notes, source, chat_name, sender_name, owner, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
`);
const getTodoStmt = db.prepare('SELECT * FROM todos WHERE id = ?');

// 迁移:schedule_users 扩展(上课前提醒/睡觉提醒/倒计时去重/网页令牌)
const suCols = db.prepare('PRAGMA table_info(schedule_users)').all().map((c) => c.name);
if (!suCols.includes('class_remind')) {
  db.exec('ALTER TABLE schedule_users ADD COLUMN class_remind INTEGER DEFAULT 1');
}
if (!suCols.includes('sleep_time')) {
  db.exec('ALTER TABLE schedule_users ADD COLUMN sleep_time TEXT DEFAULT \'\'');
}
if (!suCols.includes('last_sleep_remind')) {
  db.exec('ALTER TABLE schedule_users ADD COLUMN last_sleep_remind TEXT');
}
if (!suCols.includes('last_countdown_remind')) {
  db.exec('ALTER TABLE schedule_users ADD COLUMN last_countdown_remind TEXT');
}
if (!suCols.includes('web_token')) {
  db.exec('ALTER TABLE schedule_users ADD COLUMN web_token TEXT DEFAULT \'\'');
}

// 迁移:schedule_items 上课前提醒去重
const siCols = db.prepare('PRAGMA table_info(schedule_items)').all().map((c) => c.name);
if (!siCols.includes('reminded_day')) {
  db.exec('ALTER TABLE schedule_items ADD COLUMN reminded_day TEXT');
}

export function addTodo({ title, dueAt = null, priority = 'medium', notes = '', source = 'manual', chatName = '', senderName = '', owner = '' }) {
  const now = new Date().toISOString();
  const r = insTodo.run(title, dueAt, priority, notes, source, chatName, senderName, owner, now);
  events.emit('change');
  return getTodoStmt.get(Number(r.lastInsertRowid));
}

export function listTodos({ status = 'all', q = '', owner = null } = {}) {
  const conds = [];
  const args = [];
  if (status === 'open') conds.push("status = 'open'");
  if (status === 'done') conds.push("status = 'done'");
  if (owner !== null && owner !== undefined) {
    conds.push('owner = ?');
    args.push(owner);
  }
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
      INSERT INTO schedule_users (owner, name, semester_start, notify_time, push_kind, push_key, class_remind, sleep_time, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      owner,
      fields.name || '',
      fields.semesterStart ?? '',
      fields.notifyTime ?? '',
      fields.pushKind ?? '',
      fields.pushKey ?? '',
      fields.classRemind ?? 1,
      fields.sleepTime ?? '',
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
        class_remind = COALESCE(?, class_remind),
        sleep_time = COALESCE(?, sleep_time),
        updated_at = ?
      WHERE owner = ?
    `).run(
      fields.name ?? null,
      fields.semesterStart ?? null,
      fields.notifyTime ?? null,
      fields.pushKind ?? null,
      fields.pushKey ?? null,
      fields.classRemind ?? null,
      fields.sleepTime ?? null,
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

/* ================= 倒计时 ================= */

export function addCountdown(owner, title, target) {
  const r = db.prepare('INSERT INTO countdowns (owner, title, target, created_at) VALUES (?, ?, ?, ?)')
    .run(owner, title, target, new Date().toISOString());
  events.emit('change');
  return Number(r.lastInsertRowid);
}

export function listCountdowns(owner) {
  return db.prepare('SELECT * FROM countdowns WHERE owner = ? ORDER BY target, id').all(owner)
    .map((r) => ({ ...r, id: Number(r.id) }));
}

export function deleteCountdown(id) {
  const r = db.prepare('DELETE FROM countdowns WHERE id = ?').run(id);
  if (r.changes > 0) events.emit('change');
  return r.changes > 0;
}

export function setScheduleUserReminded(owner, field, day) {
  db.prepare(`UPDATE schedule_users SET ${field} = ? WHERE owner = ?`).run(day, owner);
}

/* ================= 每周回顾 ================= */

export function getReviewLog(owner, week) {
  return db.prepare('SELECT * FROM review_log WHERE owner = ? AND week = ?').get(owner, week) || null;
}

export function setReviewLog(owner, week) {
  db.prepare('INSERT OR REPLACE INTO review_log (owner, week, sent_at) VALUES (?, ?, ?)')
    .run(owner, week, new Date().toISOString());
}

/* ================= 上课前提醒 ================= */

export function setClassReminded(id, day) {
  db.prepare('UPDATE schedule_items SET reminded_day = ? WHERE id = ?').run(day, id);
}

/* ================= 多用户令牌 ================= */

import { randomBytes } from 'node:crypto';

export function randomToken() {
  return randomBytes(16).toString('hex');
}

export function getUserByToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM schedule_users WHERE web_token = ?').get(token) || null;
}

export function setWebToken(owner, token) {
  db.prepare('UPDATE schedule_users SET web_token = ? WHERE owner = ?').run(token, owner);
}

/* ================= Web Push 订阅 ================= */

export function addPushSubscription(owner, subscription, userAgent = '') {
  db.prepare(`
    INSERT OR REPLACE INTO push_subscriptions (owner, endpoint, keys, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(owner, subscription.endpoint, JSON.stringify(subscription.keys || {}), userAgent, new Date().toISOString());
}

export function listPushSubscriptions(owner) {
  return db.prepare('SELECT * FROM push_subscriptions WHERE owner = ?').all(owner);
}

export function deletePushSubscription(owner, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE owner = ? AND endpoint = ?').run(owner, endpoint);
}

/* ================= 学习资源 ================= */

/** 首次启动时内置一批高质量学习资源 */
const SEED_RESOURCES = [
  ['综合课程', '中国大学MOOC', 'https://www.icourse163.org', '国内最大的慕课平台,名校课程免费学'],
  ['综合课程', '学堂在线', 'https://www.xuetangx.com', '清华发起的中文慕课平台'],
  ['综合课程', '国家高等教育智慧教育平台', 'https://higher.smartedu.cn', '教育部官方课程平台'],
  ['综合课程', 'B站大学', 'https://www.bilibili.com', '海量免费课程(搜索课程名+关键词)'],
  ['综合课程', '网易公开课', 'https://open.163.com', '国内外名校公开课'],
  ['综合课程', 'Coursera', 'https://www.coursera.org', '国际名校课程(可申请助学金)'],
  ['计算机', 'LeetCode', 'https://leetcode.cn', '刷题必备,面试算法'],
  ['计算机', '洛谷', 'https://www.luogu.com.cn', '算法竞赛刷题社区'],
  ['计算机', 'GitHub', 'https://github.com', '全球最大代码托管平台'],
  ['计算机', '菜鸟教程', 'https://www.runoob.com', '编程入门速查手册'],
  ['计算机', 'MDN Web 文档', 'https://developer.mozilla.org/zh-CN', 'Web 开发权威文档'],
  ['计算机', 'CS自学指南', 'https://csdiy.wiki', '计算机自学路线图'],
  ['计算机', 'OI Wiki', 'https://oi-wiki.org', '算法竞赛知识库'],
  ['计算机', '牛客网', 'https://www.nowcoder.com', '笔试面试真题'],
  ['数学', '3Blue1Brown', 'https://space.bilibili.com/88461692', '动画讲数学,直观到上瘾'],
  ['数学', '可汗学院', 'https://zh.khanacademy.org', '从零开始的自学数学'],
  ['数学', 'WolframAlpha', 'https://www.wolframalpha.com', '计算知识引擎,解数学题'],
  ['数学', '数学乐', 'https://www.shuxuele.com', '通俗数学入门'],
  ['英语', '每日英语听力', 'https://dict.eudic.net/ting', '听力磨耳朵'],
  ['英语', '百词斩', 'https://www.baicizhan.com', '背单词'],
  ['英语', '欧路词典', 'https://dict.eudic.net', '词典+背单词一体'],
  ['英语', 'TED', 'https://www.ted.com', '演讲练听力,开阔视野'],
  ['考试考证', '全国计算机等级考试', 'https://ncre.neea.edu.cn', 'NCRE 官方报名入口'],
  ['考试考证', '中国教育考试网', 'https://www.neea.edu.cn', '四六级/教资等考试官网'],
  ['考试考证', '研招网', 'https://yz.chsi.com.cn', '考研官方信息'],
  ['论文学术', '知网 CNKI', 'https://www.cnki.net', '中文论文检索(校园网免费)'],
  ['论文学术', 'Google 学术', 'https://scholar.google.com', '学术搜索'],
  ['论文学术', 'arXiv', 'https://arxiv.org', '预印本论文库(数理/计算机)'],
  ['论文学术', '万方数据', 'https://www.wanfangdata.com.cn', '中文文献检索'],
  ['电子书', '微信读书', 'https://weread.qq.com', '海量电子书'],
  ['电子书', '鸠摩搜书', 'https://www.jiumodiary.com', '电子书搜索引擎'],
  ['电子书', '熊猫搜书', 'https://xmsoushu.com', '聚合多个电子书源'],
  ['工具', 'Overleaf', 'https://www.overleaf.com', '在线 LaTeX 论文排版'],
  ['工具', 'ProcessOn', 'https://www.processon.com', '在线画流程图/思维导图'],
  ['工具', '幕布', 'https://mubu.com', '大纲笔记+思维导图'],
  ['竞赛', '全国大学生数学建模竞赛', 'https://www.mcm.edu.cn', '数模国赛官网'],
  ['竞赛', '蓝桥杯', 'https://dasai.lanqiao.cn', '程序设计竞赛'],
  ['竞赛', '挑战杯', 'https://www.tiaozhanbei.net', '大学生课外学术科技竞赛'],
];

export function seedResources() {
  const c = db.prepare('SELECT COUNT(*) c FROM resources').get().c;
  if (Number(c) > 0) return;
  const ins = db.prepare('INSERT INTO resources (category, title, url, description, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  SEED_RESOURCES.forEach(([category, title, url, description], i) => {
    ins.run(category, title, url, description, i, new Date().toISOString());
  });
  console.log(`[资源] 已内置 ${SEED_RESOURCES.length} 条学习资源`);
}

export function listResources() {
  return db.prepare('SELECT * FROM resources ORDER BY category, sort, id').all()
    .map((r) => ({ ...r, id: Number(r.id) }));
}

export function addResource({ category, title, url, description }) {
  const r = db.prepare('INSERT INTO resources (category, title, url, description, sort, created_at) VALUES (?, ?, ?, ?, 999, ?)')
    .run(category, title, url, description, new Date().toISOString());
  events.emit('change');
  return Number(r.lastInsertRowid);
}

export function deleteResource(id) {
  const r = db.prepare('DELETE FROM resources WHERE id = ?').run(id);
  if (r.changes > 0) events.emit('change');
  return r.changes > 0;
}

// 首次启动内置学习资源
seedResources();

/* ================= 快递 ================= */

const pkgCols = db.prepare('PRAGMA table_info(packages)').all().map((c) => c.name);
if (!pkgCols.includes('company')) {
  db.exec("ALTER TABLE packages ADD COLUMN company TEXT DEFAULT ''");
}

export function addPackage(owner, code, location, company = '') {
  const r = db.prepare('INSERT INTO packages (owner, code, location, company, status, created_at) VALUES (?, ?, ?, ?, \'pending\', ?)')
    .run(owner, code, location, company, new Date().toISOString());
  events.emit('change');
  return Number(r.lastInsertRowid);
}

export function listPackages(owner) {
  return db.prepare('SELECT * FROM packages WHERE owner = ? ORDER BY status, id DESC').all(owner)
    .map((r) => ({ ...r, id: Number(r.id) }));
}

export function markPackageDone(id) {
  db.prepare("UPDATE packages SET status = 'done' WHERE id = ?").run(id);
  events.emit('change');
}

export function deletePackage(id) {
  const r = db.prepare('DELETE FROM packages WHERE id = ?').run(id);
  if (r.changes > 0) events.emit('change');
  return r.changes > 0;
}

/* ================= 留言板 ================= */

export function addPost(owner, name, content) {
  const r = db.prepare('INSERT INTO posts (owner, name, content, created_at) VALUES (?, ?, ?, ?)')
    .run(owner, name, content, new Date().toISOString());
  events.emit('change');
  return Number(r.lastInsertRowid);
}

export function listPosts(limit = 100) {
  return db.prepare('SELECT * FROM posts ORDER BY id DESC LIMIT ?').all(limit)
    .map((r) => ({ ...r, id: Number(r.id) }));
}

export function deletePost(id) {
  const r = db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  if (r.changes > 0) events.emit('change');
  return r.changes > 0;
}
