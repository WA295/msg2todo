import { config } from './config.js';
import { listScheduleUsers, listScheduleItems, getScheduleUser, setClassReminded } from './db.js';
import { partsOf, partsToStr } from './time.js';
import { buildDayText } from './schedule.js';
import { sendBark, sendPushDeer } from './notify.js';
import { sendQQPrivate } from './onebot.js';

let timer = null;

/** 上课前提醒:每 30 秒检查,课前 N 分钟 QQ+手机推送 */
export function startClassReminder() {
  console.log(`[上课提醒] 每节课前 ${config.classRemindMinutes} 分钟提醒(每 30 秒检查)`);
  timer = setInterval(check, 30000);
  check();
}

export function stopClassReminder() {
  if (timer) clearInterval(timer);
}

function notify(owner, text) {
  if (owner.startsWith('qq:')) sendQQPrivate(owner.slice(3), text);
  const u = getScheduleUser(owner);
  if (u?.push_kind === 'bark') sendBark('🔔 上课提醒', text, u.push_key);
  else if (u?.push_kind === 'pushdeer') sendPushDeer('🔔 上课提醒', text, u.push_key);
}

function hm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function check() {
  const now = new Date();
  const nowP = partsOf(now);
  const curMin = nowP.h * 60 + nowP.mi;
  const today = partsToStr(nowP);
  const ahead = config.classRemindMinutes;

  for (const u of listScheduleUsers()) {
    if (!u.class_remind) continue;
    const items = listScheduleItems(u.owner);
    if (!items.length) continue;
    const sem = u.semester_start || config.schedule.semesterStart;
    const { visible } = buildDayText(items, nowP, sem);
    // 找出即将开始(还有 ahead 分钟内)且今天还没提醒过的课
    const due = visible
      .filter((it) => it.start_min > curMin && it.start_min - curMin <= ahead && it.reminded_day !== today)
      .sort((a, b) => a.start_min - b.start_min);
    if (!due.length) continue;
    const lines = due.map((it) => `${hm(it.start_min)} ${it.name}${it.location ? ` @${it.location}` : ''}`);
    const minutes = due[0].start_min - curMin;
    const label = minutes <= 0 ? '马上开始' : `${minutes} 分钟后`;
    notify(u.owner, `🔔 ${label}有课:\n${lines.join('\n')}`);
    for (const it of due) setClassReminded(it.id, today);
    console.log(`[上课提醒] 已提醒「${u.owner}」${due.length} 节课(${label})`);
  }
}
