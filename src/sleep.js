import { db, listScheduleUsers, listScheduleItems, getScheduleUser, upsertScheduleUser, setScheduleUserReminded } from './db.js';
import { partsOf, zonedDate, partsToStr } from './time.js';
import { buildDayText } from './schedule.js';
import { sendBark, sendPushDeer } from './notify.js';
import { sendQQPrivate } from './onebot.js';
import { sendWebPush } from './push.js';

let timer = null;

/** 睡觉提醒:每 60 秒检查,到点提醒;若明天有早课(9:25 前)会提示早睡 */
export function startSleepReminder() {
  console.log('[睡觉提醒] 已启用(设置「睡觉提醒 HH:MM」后生效)');
  timer = setInterval(check, 60000);
}

export function stopSleepReminder() {
  if (timer) clearInterval(timer);
}

function notify(owner, text) {
  sendWebPush(owner, '🌙 睡觉提醒', text);
  if (owner.startsWith('qq:')) sendQQPrivate(owner.slice(3), text);
  const u = getScheduleUser(owner);
  if (u?.push_kind === 'bark') sendBark('🌙 睡觉提醒', text, u.push_key);
  else if (u?.push_kind === 'pushdeer') sendPushDeer('🌙 睡觉提醒', text, u.push_key);
}

function check() {
  const now = new Date();
  const nowP = partsOf(now);
  const curMin = nowP.h * 60 + nowP.mi;
  const today = partsToStr(nowP);

  for (const u of listScheduleUsers()) {
    if (!u.sleep_time) continue;
    const [h, m] = u.sleep_time.split(':').map(Number);
    if (curMin < h * 60 + m) continue;
    if (u.last_sleep_remind === today) continue;

    // 明天的课(找最早一节)
    const items = listScheduleItems(u.owner);
    const sem = u.semester_start || '';
    const tomP = partsOf(new Date(zonedDate(nowP.y, nowP.mo, nowP.d, 0, 0).getTime() + 86400000));
    const { visible } = buildDayText(items, tomP, sem || undefined);
    const first = visible.sort((a, b) => a.start_min - b.start_min)[0];
    let text = '🌙 该睡觉啦,早点休息~';
    if (first && first.start_min <= 9 * 60 + 25) {
      const hm = `${String(Math.floor(first.start_min / 60)).padStart(2, '0')}:${String(first.start_min % 60).padStart(2, '0')}`;
      text += `\n⚠️ 明天 ${hm} 有课「${first.name}」,有早八就别熬夜了!`;
    }
    notify(u.owner, text);
    setScheduleUserReminded(u.owner, 'last_sleep_remind', today);
    console.log(`[睡觉提醒] 已提醒「${u.owner}」(${u.sleep_time})`);
  }
}

/** 判断是否为睡觉提醒指令 */
export async function handleSleepCommand(msg) {
  const text = (msg.text || '').trim();
  if (!text) return false;
  if (!/^睡觉提醒/.test(text) && !/^关闭睡觉提醒/.test(text)) return false;
  const owner = `${msg.platform}:${msg.chatId}`;
  const reply = async (t) => {
    if (typeof msg.reply === 'function') {
      try { await msg.reply(t); } catch (e) { console.warn('[睡觉提醒] 回复失败:', e.message); }
    }
  };

  if (/^关闭睡觉提醒/.test(text)) {
    upsertScheduleUser(owner, { sleepTime: '' });
    await reply('🔕 已关闭睡觉提醒');
    return true;
  }
  const m = text.match(/^睡觉提醒\s*[:：]?\s*(\d{1,2})[:：](\d{2})$/);
  if (!m) {
    await reply('格式:睡觉提醒 23:00(或发「关闭睡觉提醒」取消)');
    return true;
  }
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) {
    await reply('时间格式不对,请用:睡觉提醒 23:00');
    return true;
  }
  upsertScheduleUser(owner, { sleepTime: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` });
  await reply(`✅ 已设置每天 ${m[1]}:${m[2]} 提醒你睡觉\n如果第二天有早课,还会提醒你别熬夜`);
  return true;
}
