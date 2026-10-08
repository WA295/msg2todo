import { config } from './config.js';
import { db, getScheduleUser, upsertScheduleUser, addCountdown, listCountdowns, deleteCountdown, setScheduleUserReminded } from './db.js';
import { partsOf, daysUntil, partsToStr } from './time.js';
import { sendBark, sendPushDeer } from './notify.js';
import { sendQQPrivate } from './onebot.js';
import { sendWebPush } from './push.js';

let timer = null;

export function startCountdownReminder() {
  console.log(`[倒计时] 每天 ${config.countdownNotifyTime} 推送倒计时(考前 7/3/1 天强调提醒)`);
  timer = setInterval(() => { check().catch((e) => console.warn('[倒计时] 检查出错:', e.message)); }, 60000);
  check().catch(() => {});
}

export function stopCountdownReminder() {
  if (timer) clearInterval(timer);
}

function notify(owner, text, title = '⏳ 倒计时') {
  sendWebPush(owner, title, text);
  if (owner.startsWith('qq:')) sendQQPrivate(owner.slice(3), text);
  const u = getScheduleUser(owner);
  if (u?.push_kind === 'bark') sendBark(title, text, u.push_key);
  else if (u?.push_kind === 'pushdeer') sendPushDeer(title, text, u.push_key);
}

/** 新建倒计时后立即推送一条(供 QQ 指令与 App 接口共用) */
export function pushCountdownNow(owner, title, target) {
  const left = daysUntil(target, partsOf(new Date()));
  const mark = left < 0 ? `已过 ${Math.abs(left)} 天` : left === 0 ? '就是今天!🎯' : `还有 ${left} 天`;
  notify(owner, `⏳ 倒计时已创建:「${title}」 ${mark}\n每天 08:00 我会提醒你剩余天数`);
}

async function check() {
  const nowP = partsOf(new Date());
  const curMin = nowP.h * 60 + nowP.mi;
  const [h, m] = config.countdownNotifyTime.split(':').map(Number);
  if (curMin < h * 60 + m) return;
  const today = partsToStr(nowP);

  const owners = db.prepare('SELECT DISTINCT owner FROM countdowns').all();
  for (const { owner } of owners) {
    let u = getScheduleUser(owner);
    if (!u) u = upsertScheduleUser(owner, {}); // 补建用户记录,保证去重字段可用
    if (u.last_countdown_remind === today) continue;
    const cds = listCountdowns(owner).filter((c) => c.target >= today);
    if (!cds.length) continue;
    const lines = cds.map((c) => {
      const left = daysUntil(c.target, nowP);
      let mark = '';
      if (left === 0) mark = '就是今天!🎯';
      else if ([1, 3, 7].includes(left)) mark = `只剩 ${left} 天!🔥`;
      else if (left <= 14) mark = `剩 ${left} 天`;
      return `${c.title}:${mark || `还有 ${left} 天`}`;
    });
    const text = `⏳ 倒计时提醒\n${lines.join('\n')}`;
    notify(owner, text);
    setScheduleUserReminded(owner, 'last_countdown_remind', today);
    console.log(`[倒计时] 已推送 ${cds.length} 条倒计时给「${owner}」`);
  }
}
export { check as checkCountdowns };

/** 判断是否为倒计时指令 */
export async function handleCountdownCommand(msg) {
  const text = (msg.text || '').trim();
  if (!text) return false;
  if (!/^倒计时/.test(text) && !/^我的倒计时/.test(text) && !/^(删除倒计时|取消倒计时)/.test(text)) return false;
  const owner = `${msg.platform}:${msg.chatId}`;
  const reply = async (t) => {
    if (typeof msg.reply === 'function') {
      try { await msg.reply(t); } catch (e) { console.warn('[倒计时] 回复失败:', e.message); }
    }
  };

  // 列表
  if (/^(倒计时|我的倒计时)$/.test(text)) {
    const cds = listCountdowns(owner);
    if (!cds.length) {
      await reply('你还没有倒计时。发送「倒计时 12月12日 四六级」创建(支持:倒计时 2026-12-12 名称)');
      return true;
    }
    const nowP = partsOf(new Date());
    const lines = cds.map((c, i) => {
      const left = daysUntil(c.target, nowP);
      const mark = left < 0 ? '已过 ' + Math.abs(left) + ' 天' : left === 0 ? '就是今天!' : `还有 ${left} 天`;
      return `${i + 1}. ${c.title}(${c.target.slice(5).replace('-', '月')}日) ${mark}`;
    });
    await reply('⏳ 我的倒计时\n' + lines.join('\n') + '\n删除:发「删除倒计时 1」');
    return true;
  }

  // 删除
  const delM = text.match(/^(?:删除倒计时|取消倒计时)\s*(\d+)$/);
  if (delM) {
    const cds = listCountdowns(owner);
    const idx = Number(delM[1]) - 1;
    if (cds[idx] && deleteCountdown(cds[idx].id)) await reply(`🗑️ 已删除「${cds[idx].title}」`);
    else await reply('没有找到这条倒计时,发「倒计时」查看列表');
    return true;
  }

  // 创建:倒计时 <日期> <名称>(支持 2026-12-12 / 2026年12月12日 / 12月12日)
  const addM = text.match(/^倒计时\s*(.+)$/);
  if (addM) {
    const body = addM[1].trim();
    let y = null;
    let mo = null;
    let d = null;
    let title = '';
    let m = body.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:\s+|$)(.*)$/);
    if (m) {
      y = Number(m[1]);
      mo = Number(m[2]);
      d = Number(m[3]);
      title = m[4];
    } else {
      m = body.match(/^(\d{1,2})月(\d{1,2})日?(?:\s+|$)(.*)$/);
      if (!m) {
        await reply('格式不对,请用:倒计时 2026-12-12 四六级(或 倒计时 12月12日 四六级)');
        return true;
      }
      mo = Number(m[1]);
      d = Number(m[2]);
      title = m[3];
      const np = partsOf(new Date());
      y = np.y;
      // 今年已过 → 默认明年
      if (Date.UTC(y, mo - 1, d) < Date.UTC(np.y, np.mo - 1, np.d)) y += 1;
    }
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
      await reply('日期无效,请检查');
      return true;
    }
    const target = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const name = title.trim().slice(0, 30) || '倒计时';
    addCountdown(owner, name, target);
    const left = daysUntil(target, partsOf(new Date()));
    pushCountdownNow(owner, name, target);
    await reply(`✅ 已创建「${name}」,目标 ${y}年${mo}月${d}日,${left < 0 ? `已过 ${Math.abs(left)} 天` : `还有 ${left} 天`}\n考前 7/3/1 天和到期日会重点提醒`);
    return true;
  }

  return false;
}
