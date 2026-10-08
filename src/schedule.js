import { config } from './config.js';
import {
  getScheduleUser,
  upsertScheduleUser,
  replaceSchedule,
  addScheduleItems,
  listScheduleItems,
  clearSchedule,
} from './db.js';
import { extractScheduleWithLLM } from './llm.js';
import { partsOf, weekOf } from './time.js';

/** 星期名:下标与 time.js 的 wd 一致(0=周日) */
export const WD_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const DAY_MAP = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
  0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 0,
};

/* ================= 规则解析 ================= */

/** 解析一段课程文本(某个时间之后、下一个时间/星期之前),支持一行多节课 */
function parseCourseSegment(seg, day) {
  const s = String(seg).trim();
  if (!s) return null;
  // 周次:1-8周 / 17周 / 3-8周,10-18周 等
  const tokens = [];
  for (const m of s.matchAll(/(\d{1,2})\s*[-~～—至到]\s*(\d{1,2})\s*周/g)) tokens.push([Number(m[1]), Number(m[2])]);
  for (const m of s.matchAll(/(\d{1,2})\s*周/g)) {
    const n = Number(m[1]);
    const before = s.slice(Math.max(0, m.index - 3), m.index);
    if (!/\d\s*[-~～—至到]\s*$/.test(before)) tokens.push([n, n]);
  }
  const pM = s.match(/单周|双周|[(（]\s*([单双])\s*[)）]/);
  const parity = pM ? (/单/.test(pM[0]) ? 'odd' : 'even') : '';

  let name = s;
  let location = '';
  const atIdx = s.search(/[@＠]/);
  if (atIdx >= 0) {
    name = s.slice(0, atIdx);
    location = s
      .slice(atIdx + 1)
      .replace(/\(?\s*\d{1,2}(?:\s*[-~～—至到]\s*\d{1,2})?\s*周\)?/g, ' ')
      .replace(/\d{1,2}\s*周/g, ' ')
      .replace(/[单双]周/g, ' ')
      .replace(/[(（]\s*[单双]\s*[)）]/g, ' ')
      .replace(/[,，、;:：()（）]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  name = name
    .replace(/\(?\s*\d{1,2}(?:\s*[-~～—至到]\s*\d{1,2})?\s*周\)?/g, ' ')
    .replace(/\d{1,2}\s*周/g, ' ')
    .replace(/[单双]周/g, ' ')
    .replace(/[(（]\s*[单双]\s*[)）]/g, ' ')
    .replace(/[,，。.;;、:：()（）[\]【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.length > 40) return null;
  return { day, name, location, tokens, parity };
}

/** 解析整段课表文本,返回 { items, failed }。支持:一行多节课、星期带冒号、整段挤成一行 */
export function parseScheduleText(text) {
  const src = String(text || '');
  const items = [];
  const failed = [];

  // 找到所有星期标记(周一 / 星期一 / 周一: …),按其切段
  const dayRe = /(?:周|星期|礼拜)\s*([一二三四五六日天0-7])\s*[:：]?/g;
  const marks = [];
  let dm;
  while ((dm = dayRe.exec(src))) marks.push({ idx: dm.index, end: dm.index + dm[0].length, day: DAY_MAP[dm[1]] ?? 1 });

  if (!marks.length) {
    // 没有星期标记:按行记录失败(提示用户看格式)
    for (const l of src.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) failed.push(l);
    return { items, failed };
  }

  const timeRe = /(\d{1,2})[:：](\d{2})\s*[-~～—至到]\s*(\d{1,2})[:：](\d{2})/g;
  const segments = [];
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].end;
    const to = i + 1 < marks.length ? marks[i + 1].idx : src.length;
    segments.push({ day: marks[i].day, text: src.slice(from, to) });
  }

  for (const seg of segments) {
    const times = [];
    timeRe.lastIndex = 0;
    let tm;
    while ((tm = timeRe.exec(seg.text))) {
      times.push({
        idx: tm.index,
        end: tm.index + tm[0].length,
        startMin: Number(tm[1]) * 60 + Number(tm[2]),
        endMin: Number(tm[3]) * 60 + Number(tm[4]),
      });
    }
    if (!times.length) {
      if (seg.text.trim()) failed.push(seg.text.slice(0, 24));
      continue;
    }
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (t.startMin >= t.endMin || t.endMin > 24 * 60) continue;
      const courseSeg = seg.text.slice(t.end, i + 1 < times.length ? times[i + 1].idx : seg.text.length);
      const c = parseCourseSegment(courseSeg, seg.day);
      if (!c) { failed.push(courseSeg.slice(0, 24)); continue; }
      if (c.tokens.length) {
        if (c.parity) {
          const ws = Math.min(...c.tokens.map((x) => x[0]));
          const we = Math.max(...c.tokens.map((x) => x[1]));
          items.push({ day: seg.day, startMin: t.startMin, endMin: t.endMin, name: c.name, location: c.location, weekStart: ws, weekEnd: we, parity: c.parity });
        } else {
          for (const [a, b] of c.tokens) {
            items.push({ day: seg.day, startMin: t.startMin, endMin: t.endMin, name: c.name, location: c.location, weekStart: a, weekEnd: b, parity: '' });
          }
        }
      } else {
        items.push({ day: seg.day, startMin: t.startMin, endMin: t.endMin, name: c.name, location: c.location, weekStart: null, weekEnd: null, parity: '' });
      }
    }
  }
  return { items, failed };
}

/* ================= 工具 ================= */

function hm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function weekLabel(it) {
  const parts = [];
  if (it.week_start && it.week_end) {
    parts.push(it.week_start === it.week_end ? `${it.week_start}周` : `${it.week_start}-${it.week_end}周`);
  }
  if (it.parity === 'odd') parts.push('单周');
  if (it.parity === 'even') parts.push('双周');
  return parts.length ? ` (${parts.join(' ')})` : '';
}

function semOf(user) {
  return (user && user.semester_start) || config.schedule.semesterStart || '';
}

async function reply(msg, text) {
  if (typeof msg.reply !== 'function') return;
  try {
    await msg.reply(text);
  } catch (e) {
    console.warn('[课表] 回复失败:', e.message);
  }
}

/**
 * 生成某一天的课程文本(供「明天什么课」查询与每晚提醒共用)。
 * @param {Array} items 该学生的全部课程
 * @param {object} p 目标日期的 partsOf 结果
 * @param {string} sem 开学日期(可空)
 */
export function buildDayText(items, p, sem) {
  const week = sem ? weekOf(p, sem) : null;
  const visible = [];
  let unknownWeek = false;
  for (const it of items) {
    if (it.day !== p.wd) continue;
    if (week !== null) {
      if (it.week_start && it.week_end && (week < it.week_start || week > it.week_end)) continue;
      if (it.parity && (week % 2 === 1) !== (it.parity === 'odd')) continue;
    } else if (it.week_start || it.parity) {
      unknownWeek = true; // 没开学日期,周次无法判断,先全部列出
    }
    visible.push(it);
  }
  visible.sort((a, b) => a.start_min - b.start_min);
  const text = visible.length
    ? visible.map((it, i) => `${i + 1}. ${hm(it.start_min)}-${hm(it.end_min)} ${it.name}${it.location ? ` @${it.location}` : ''}${weekLabel(it)}`).join('\n')
    : '没有课,好好休息~ 🎉';
  let hint = '';
  if (unknownWeek && visible.length) {
    hint = '未设置开学日期,周次/单双周课程已全部列出;发送「开学日期 YYYY-MM-DD」可精确判断';
  }
  return { text, hint, visible };
}

/* ================= 指令处理 ================= */

const HELP = `📚 课表功能使用说明

1️⃣ 设置课表(整体覆盖,可多行):
课表
周一 08:00-09:40 高等数学 @一教101
周一 10:00-11:40 大学英语 1-16周
周二 14:00-15:40 物理实验 双周

2️⃣ 追加课程:发「添加课」+ 课程行
3️⃣ 查询课表:我的课表
4️⃣ 查询课程:明天什么课 / 今天什么课
5️⃣ 开学日期:开学日期 2026-02-23(单双周/周次判断用)
6️⃣ 每晚提醒时间:提醒时间 21:00(默认 ${config.schedule.notifyTime})
7️⃣ 绑定手机推送:设置推送 <Bark地址 或 PDU开头的PushDeer key>
   取消推送:取消推送
8️⃣ 清空课表:清空课表`;

/**
 * 判断消息是否为课表指令,是则处理并返回 true。
 * 在 todo.js 的待办管线之前调用,避免课表文本被误判为待办。
 */
export async function handleScheduleCommand(msg) {
  const text = (msg.text || '').trim();
  if (!text) return false;
  const owner = `${msg.platform}:${msg.chatId}`;

  // 帮助
  if (/^(课表帮助|课表说明|课表用法|使用说明)/.test(text)) {
    await reply(msg, HELP);
    return true;
  }

  // 查询我的课表
  if (/^(我的课表|课表查询|查询课表|查看课表)$/.test(text)) {
    await showMySchedule(msg, owner);
    return true;
  }

  // 明天 / 今天的课
  if (/^明天(的|什么|上什么)?课|^明天课表/.test(text)) {
    await showDaySchedule(msg, owner, 1);
    return true;
  }
  if (/^今天(的|什么|上什么)?课|^今天课表/.test(text)) {
    await showDaySchedule(msg, owner, 0);
    return true;
  }

  // 清空课表
  if (/^(清空课表|删除课表|重置课表)/.test(text)) {
    clearSchedule(owner);
    await reply(msg, '🗑️ 已清空你的课表');
    return true;
  }

  // 开学日期
  const semM = text.match(/^(?:开学日期|设置开学|学期开始|开学时间)\s*[:：]?\s*(.+)$/);
  if (semM) {
    await setSemester(msg, owner, semM[1]);
    return true;
  }

  // 每晚提醒时间
  const ntM = text.match(/^(?:提醒时间|设置提醒|每晚提醒)\s*[:：]?\s*(\d{1,2})[:：](\d{2})$/);
  if (ntM) {
    const h = Number(ntM[1]);
    const mi = Number(ntM[2]);
    if (h > 23 || mi > 59) {
      await reply(msg, '时间格式不对,请用:提醒时间 21:00');
      return true;
    }
    upsertScheduleUser(owner, { name: msg.sender, notifyTime: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` });
    await reply(msg, `✅ 已设置每晚 ${ntM[1]}:${ntM[2]} 提醒你第二天的课程`);
    return true;
  }

  // 手机推送绑定/取消
  if (/^(取消推送|解绑推送|停止推送)/.test(text)) {
    upsertScheduleUser(owner, { name: msg.sender, pushKind: '', pushKey: '' });
    await reply(msg, '🔕 已取消手机推送,每晚提醒只发 QQ');
    return true;
  }
  const pushM = text.match(/^(?:设置推送|绑定推送|推送设置)\s*[:：]?\s*(.+)$/);
  if (pushM) {
    await setPush(msg, owner, pushM[1]);
    return true;
  }

  // 追加课程
  const addM = text.match(/^(?:添加课|加课|追加课程)\s*[:：]?\s*([\s\S]*)$/);
  if (addM) {
    await setSchedule(msg, owner, addM[1], { append: true });
    return true;
  }

  // 设置课表(整体覆盖)
  const setM = text.match(/^(?:课表|课表设置|设置课表|导入课表|更新课表)\s*[:：]?\s*([\s\S]*)$/);
  if (setM) {
    await setSchedule(msg, owner, setM[1], { append: false });
    return true;
  }

  return false;
}

async function setSchedule(msg, owner, content, { append }) {
  content = String(content || '').trim();
  if (!content) {
    await reply(msg, HELP);
    return;
  }
  const { items, failed } = parseScheduleText(content);
  let used = items;
  let method = 'rules';
  if (items.length === 0 && config.llm.enabled) {
    try {
      used = await extractScheduleWithLLM(content);
      method = 'llm';
    } catch (e) {
      console.warn('[课表] LLM 解析失败,保持规则结果:', e.message);
    }
  }
  if (used.length === 0) {
    await reply(msg, '❌ 没看懂你发的课表,请参考格式:\n周一 08:00-09:40 高等数学 @一教101\n发送「课表帮助」查看完整说明');
    return;
  }
  upsertScheduleUser(owner, { name: msg.sender });
  if (append) addScheduleItems(owner, used);
  else replaceSchedule(owner, used);

  console.log(`[课表] ${append ? '追加' : '保存'} ${used.length} 节课 (${owner}, ${method})`);
  let line = append ? `✅ 已添加 ${used.length} 节课` : `✅ 课表已保存,共 ${used.length} 节课`;
  if (method === 'rules' && failed.length) {
    line += `\n⚠️ 有 ${failed.length} 行没解析成功:${failed.slice(0, 3).join(' / ')}${failed.length > 3 ? ' 等' : ''}`;
  }
  line += '\n发「我的课表」可查看;有单双周课程时发「开学日期 YYYY-MM-DD」设置学期';
  await reply(msg, line);
}

async function setSemester(msg, owner, raw) {
  const m = String(raw).trim().match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/);
  if (!m) {
    await reply(msg, '日期格式不对,请用:开学日期 2026-02-23');
    return;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    await reply(msg, '日期无效,请检查');
    return;
  }
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  upsertScheduleUser(owner, { name: msg.sender, semesterStart: iso });
  const wk = weekOf(partsOf(new Date()), iso);
  await reply(msg, `✅ 开学日期已设置为 ${iso}(所在周为第 1 周)\n今天是第 ${wk} 周`);
}

async function setPush(msg, owner, raw) {
  const key = String(raw).trim();
  if (!key) {
    await reply(msg, '请带上推送密钥,例如:\n设置推送 https://api.day.app/你的Bark密钥\niOS 用 Bark,安卓用 PushDeer(PDU 开头的 key)');
    return;
  }
  let kind = '';
  let k = key;
  if (/^PDU/i.test(key) || /pushdeer/i.test(key)) {
    kind = 'pushdeer';
    k = key.replace(/^.*(PDU\w+).*$/i, '$1');
  } else if (key.includes('api.day.app') || /^https?:\/\//i.test(key)) {
    kind = 'bark';
  } else if (/^[A-Za-z0-9]{16,}$/.test(key)) {
    kind = 'bark';
  }
  if (!kind) {
    await reply(msg, '❌ 无法识别推送密钥类型。请发送 Bark 完整地址(https://api.day.app/xxx)或 PushDeer 的 pushkey(PDU 开头)');
    return;
  }
  upsertScheduleUser(owner, { name: msg.sender, pushKind: kind, pushKey: k });
  await reply(msg, `✅ 已绑定 ${kind === 'bark' ? 'Bark(iOS)' : 'PushDeer(安卓)'} 手机推送\n以后每晚提醒会同时推到你的手机`);
}

async function showMySchedule(msg, owner) {
  const items = listScheduleItems(owner);
  const user = getScheduleUser(owner);
  if (!items.length) {
    await reply(msg, '你还没有课表。发送「课表」加课程行开始设置,例如:\n课表\n周一 08:00-09:40 高等数学 @一教101');
    return;
  }
  const byDay = {};
  for (const it of items) (byDay[it.day] ||= []).push(it);
  const lines = ['📚 我的课表'];
  for (let wd = 1; wd <= 6; wd++) {
    if (byDay[wd]) lines.push(formatDayLines(byDay[wd], WD_NAMES[wd]));
  }
  if (byDay[0]) lines.push(formatDayLines(byDay[0], '周日'));

  const sem = semOf(user);
  const meta = [];
  if (sem) meta.push(`开学 ${sem} · 当前第 ${weekOf(partsOf(new Date()), sem)} 周`);
  meta.push(`每晚提醒 ${user?.notify_time || config.schedule.notifyTime}`);
  meta.push(user?.push_kind ? `手机推送 ${user.push_kind === 'bark' ? 'Bark' : 'PushDeer'}` : '未绑定手机推送');
  lines.push('ℹ️ ' + meta.join(' · '));
  await reply(msg, lines.join('\n'));
}

function formatDayLines(items, dayName) {
  const head = `${dayName}:`;
  const body = items
    .slice()
    .sort((a, b) => a.start_min - b.start_min)
    .map((it) => `  ${hm(it.start_min)}-${hm(it.end_min)} ${it.name}${it.location ? ` @${it.location}` : ''}${weekLabel(it)}`);
  return [head, ...body].join('\n');
}

async function showDaySchedule(msg, owner, offsetDays) {
  const items = listScheduleItems(owner);
  if (!items.length) {
    await reply(msg, '你还没有课表。发送「课表」加课程行开始设置,例如:\n课表\n周一 08:00-09:40 高等数学 @一教101');
    return;
  }
  const user = getScheduleUser(owner);
  const sem = semOf(user);
  const p = partsOf(new Date(Date.now() + offsetDays * 86400000));
  const { text, hint } = buildDayText(items, p, sem);
  const label = offsetDays === 1 ? '明天' : '今天';
  await reply(msg, `📚 ${label}(${p.mo}月${p.d}日 ${WD_NAMES[p.wd]})${sem ? ` · 第${weekOf(p, sem)}周` : ''}:\n${text}${hint ? `\n⚠️ ${hint}` : ''}`);
}
