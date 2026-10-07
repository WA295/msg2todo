import { config } from './config.js';
import { db, listScheduleUsers, listScheduleItems, getScheduleUser, getReviewLog, setReviewLog, listCountdowns } from './db.js';
import { partsOf, weekOf, zonedDate, weekMondayStr, daysUntil } from './time.js';
import { buildDayText } from './schedule.js';
import { sendBark, sendPushDeer } from './notify.js';
import { sendQQPrivate } from './onebot.js';

let timer = null;

/** 每周回顾:周日指定时间推送本周总结 */
export function startWeeklyReview() {
  console.log(`[周报] 每周日 ${config.weeklyReviewTime} 推送本周回顾`);
  timer = setInterval(() => { check().catch((e) => console.warn('[周报] 检查出错:', e.message)); }, 60000);
  check().catch(() => {});
}

export function stopWeeklyReview() {
  if (timer) clearInterval(timer);
}

function notify(owner, text) {
  if (owner.startsWith('qq:')) sendQQPrivate(owner.slice(3), text);
  const u = getScheduleUser(owner);
  if (u?.push_kind === 'bark') sendBark('📊 本周回顾', text, u.push_key);
  else if (u?.push_kind === 'pushdeer') sendPushDeer('📊 本周回顾', text, u.push_key);
}

/** 生成某学生的一周回顾文本(纯函数,便于测试) */
export function buildWeeklyReport({ u, items, cds, pomo, doneTodos, openTodos, classCount, nowP }) {
  const lines = [`📊 本周回顾(截至 ${nowP.mo}月${nowP.d}日)`];
  const bits = [];
  bits.push(`✅ 完成待办 ${doneTodos} 个${openTodos ? ` · 还剩 ${openTodos} 个` : ''}`);
  if (pomo.c > 0) bits.push(`🍅 番茄 ${pomo.c} 个 · 专注 ${(pomo.m / 60).toFixed(1)} 小时`);
  if (classCount > 0) bits.push(`📚 上了 ${classCount} 节课`);
  if (bits.length) lines.push(bits.join(' · '));
  if (cds.length) {
    lines.push('⏳ ' + cds.map((c) => {
      const left = daysUntil(c.target, nowP);
      return `${c.title} 还有 ${left} 天`;
    }).join(' · '));
  }
  const todoHint = openTodos > 0 ? '\n💪 下周继续加油!' : '\n🎉 本周任务清空,太强了!';
  return lines.join('\n') + todoHint;
}

async function check() {
  const now = new Date();
  const nowP = partsOf(now);
  if (nowP.wd !== 0) return; // 只在周日
  const [h, m] = config.weeklyReviewTime.split(':').map(Number);
  if (nowP.h * 60 + nowP.mi < h * 60 + m) return;
  const week = weekMondayStr(nowP);
  // 本周一 00:00(配置时区)→ UTC ISO
  const [wy, wmo, wd] = week.split('-').map(Number);
  const weekStartIso = zonedDate(wy, wmo, wd, 0, 0).toISOString();

  for (const u of listScheduleUsers()) {
    if (getReviewLog(u.owner, week)) continue;
    const owner = u.owner;
    const items = listScheduleItems(owner);
    const cds = listCountdowns(owner).filter((c) => c.target >= week);
    const pomo = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(focus_min),0) m FROM pomodoro_log WHERE owner = ? AND finished_at >= ?').get(owner, weekStartIso);
    const anyTodos = db.prepare('SELECT COUNT(*) c FROM todos').get().c > 0;
    if (!items.length && !cds.length && !pomo.c && !anyTodos) continue;

    const doneTodos = db.prepare("SELECT COUNT(*) c FROM todos WHERE status='done' AND done_at >= ?").get(weekStartIso).c;
    const openTodos = db.prepare("SELECT COUNT(*) c FROM todos WHERE status='open'").get().c;

    // 本周课程数(周一~今天)
    const sem = u.semester_start || config.schedule.semesterStart;
    let classCount = 0;
    for (let wd = 1; wd <= 5; wd++) {
      const base = zonedDate(wy, wmo, wd, 12, 0);
      const d = new Date(base.getTime() + (wd - 1) * 86400000);
      if (d.getTime() > now.getTime()) break;
      const p = partsOf(d);
      classCount += buildDayText(items, p, sem).visible.length;
    }

    const text = buildWeeklyReport({ u, items, cds, pomo, doneTodos, openTodos, classCount, nowP });
    notify(owner, text);
    setReviewLog(owner, week);
    console.log(`[周报] 已推送本周回顾给「${owner}」`);
  }
}
export { check as checkWeeklyReview };
