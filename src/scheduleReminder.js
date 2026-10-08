import { config } from './config.js';
import { db, listScheduleUsers, listScheduleItems } from './db.js';
import { partsOf, weekOf, zonedDate, partsToStr } from './time.js';
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
  const today = partsToStr(nowP);

  for (const u of listScheduleUsers()) {
    const items = listScheduleItems(u.owner);
    if (!items.length) continue;
    // 多时段:个人 schedule_times JSON 数组,空则用 notify_time 或全局默认
    let slots = [];
    try { slots = JSON.parse(u.schedule_times || '[]'); } catch {}
    if (!Array.isArray(slots) || !slots.length) slots = [u.notify_time || config.schedule.notifyTime];
    slots = slots.filter((s) => /^\d{1,2}:\d{2}$/.test(s)).sort();

    // 去重:last_remind 格式 "YYYY-MM-DD HH:MM"
    // 注意:老数据只存了日期(长度 < 16),无法判断已发时段 → 放行,避免永久卡住当天提醒
    let lastSlot = '';
    if (u.last_remind && u.last_remind.startsWith(today) && u.last_remind.length >= 16) {
      lastSlot = u.last_remind.slice(11, 16);
    }

    for (const slot of slots) {
      if (slot <= lastSlot) continue;
      const [sh, sm] = slot.split(':').map(Number);
      if (curMin < sh * 60 + sm) continue;

      // 明天的课
      const tom = new Date(zonedDate(nowP.y, nowP.mo, nowP.d, 0, 0).getTime() + 86400000);
      const tomP = partsOf(tom);
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

      lastSlot = slot;
      db.prepare('UPDATE schedule_users SET last_remind = ? WHERE owner = ?').run(`${today} ${slot}`, u.owner);
      console.log(`[课表] 已提醒「${u.name || u.owner}」${today} ${slot}(${u.push_kind ? `QQ+${u.push_kind}` : 'QQ'})`);
    }
  }
}
