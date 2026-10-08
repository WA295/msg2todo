import { config } from './config.js';
import { db, listScheduleUsers, listScheduleItems } from './db.js';
import { partsOf, weekOf, zonedDate } from './time.js';
import { buildDayText, WD_NAMES } from './schedule.js';
import { sendBark, sendPushDeer } from './notify.js';
import { sendQQPrivate } from './onebot.js';
import { sendWebPush } from './push.js';

let timer = null;

/** 每晚到点检查:提醒每个学生第二天的课程(QQ 私聊 + 已绑定的手机推送) */
export function startScheduleReminder() {
  console.log(`[课表] 每晚 ${config.schedule.notifyTime} 提醒学生明天的课程(每 30 秒检查一次)`);
  timer = setInterval(check, 30000);
  check();
}

export function stopScheduleReminder() {
  if (timer) clearInterval(timer);
}

function check() {
  const nowP = partsOf(new Date());
  const curMin = nowP.h * 60 + nowP.mi;

  for (const u of listScheduleUsers()) {
    const items = listScheduleItems(u.owner);
    if (!items.length) continue;

    const [nh, nmi] = (u.notify_time || config.schedule.notifyTime).split(':').map(Number);
    if (curMin < nh * 60 + nmi) continue;

    // 明天的日期(按配置时区)
    const tom = new Date(zonedDate(nowP.y, nowP.mo, nowP.d, 0, 0).getTime() + 86400000);
    const tomP = partsOf(tom);
    const tomStr = `${tomP.y}-${String(tomP.mo).padStart(2, '0')}-${String(tomP.d).padStart(2, '0')}`;
    if (u.last_remind === tomStr) continue; // 今天已提醒过"明天"

    const sem = u.semester_start || config.schedule.semesterStart;
    const week = sem ? weekOf(tomP, sem) : null;
    const { text, hint } = buildDayText(items, tomP, sem);
    const head = `📚 明天(${tomP.mo}月${tomP.d}日 ${WD_NAMES[tomP.wd]})${week ? ` · 第${week}周` : ''}的课`;
    const body = `${head}:\n${text}${hint ? `\n⚠️ ${hint}` : ''}`;

    const userId = u.owner.startsWith('qq:') ? u.owner.slice(3) : '';
    if (userId) {
      const sent = sendQQPrivate(userId, body);
      if (!sent) console.warn(`[课表] QQ 未连接,无法给「${u.name || u.owner}」发送提醒`);
    }
    sendWebPush(u.owner, head, body);
    if (u.push_kind === 'bark') sendBark(head, body, u.push_key);
    else if (u.push_kind === 'pushdeer') sendPushDeer(head, body, u.push_key);

    db.prepare('UPDATE schedule_users SET last_remind = ? WHERE owner = ?').run(tomStr, u.owner);
    console.log(`[课表] 已提醒「${u.name || u.owner}」${tomStr} 的课程(${u.push_kind ? `QQ+${u.push_kind}` : 'QQ'})`);
  }
}
