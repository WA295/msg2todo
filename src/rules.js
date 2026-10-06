import { nowParts, partsOf, zonedDate } from './time.js';

/** 本地规则提取器:LLM 不可用时的兜底方案 */

const TRIGGERS = ['提醒', '记得', '别忘了', '别忘', '待办', '备忘', '要做', '需要做', '帮我记录', '记一下', '记住', '催我', '通知我', '叫我', '喊我'];
const TIME_PATTERNS = [
  /今天|今晚|今早|明天|明早|明晚|后天|大后天/,
  /周[一二三四五六日天]/,
  /下(?:个)?周|下礼拜|下个月/,
  /\d{1,2}月\d{1,2}[日号]/,
  /\d{1,2}[点时:：]/,
  /\d{1,2}小时后/,
  /凌晨|早上|上午|中午|下午|傍晚|晚上|夜里/,
];
const PRIORITY_HIGH = ['紧急', '尽快', '马上', '立刻', '重要', '截止', '必须', '赶紧', '火速', 'asap', 'ASAP'];

export function extractTodoWithRules(text) {
  const t = text.trim();
  if (!t) return { isTodo: false, title: '', dueAt: null, priority: 'medium', notes: '' };
  const hasTrigger = TRIGGERS.some((k) => t.includes(k));
  const hasTime = TIME_PATTERNS.some((r) => r.test(t));
  if (!hasTrigger && !hasTime) return { isTodo: false, title: '', dueAt: null, priority: 'medium', notes: '' };

  let title = t
    .replace(/^(请|麻烦你|麻烦|帮我|给我|帮我记得|帮我记住|记得|别忘了|别忘记|提醒我|提醒|帮我提醒|到时候)/, '')
    .replace(/[。.!！?？,，;；\s]+$/, '')
    .trim();
  if (!title) title = t;

  return {
    isTodo: true,
    title,
    dueAt: parseCnTime(t),
    priority: PRIORITY_HIGH.some((k) => t.includes(k)) ? 'high' : 'medium',
    notes: '',
  };
}

const WD = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/** 解析中文时间表达,返回 ISO 字符串或 null */
export function parseCnTime(text) {
  const now = nowParts();

  // "N小时后"
  const mHours = text.match(/(\d{1,2})\s*小时(?:后|以后)/);
  if (mHours) return new Date(Date.now() + Number(mHours[1]) * 3600e3).toISOString();

  let y = now.y, mo = now.mo, d = now.d;
  let dayOffset = 0;

  if (/大后天/.test(text)) dayOffset = 3;
  else if (/后天/.test(text)) dayOffset = 2;
  else if (/明天|明早|明晚/.test(text)) dayOffset = 1;

  // 周X / 下周X
  const mWd = text.match(/周([一二三四五六日天])/);
  if (mWd) {
    let off = (WD[mWd[1]] - now.wd + 7) % 7;
    if (off === 0) off = 7;
    if (/下(?:个)?周|下礼拜/.test(text)) off += 7;
    dayOffset = off;
  }

  // 显式日期 X月X日
  const mDate = text.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (mDate) {
    const mm = Number(mDate[1]), dd = Number(mDate[2]);
    if (mm < now.mo || (mm === now.mo && dd < now.d)) y += 1;
    mo = mm;
    d = dd;
  } else if (dayOffset > 0) {
    const p = partsOf(new Date(zonedDate(now.y, now.mo, now.d, 12, 0).getTime() + dayOffset * 86400000));
    y = p.y; mo = p.mo; d = p.d;
  }

  // 时间
  let hh = null, mm = 0;
  const m24 = text.match(/(\d{1,2}):(\d{2})/);
  const mCn = text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2})\s*[点时](半)?/);
  if (m24) {
    hh = Number(m24[1]); mm = Number(m24[2]);
  } else if (mCn) {
    const period = mCn[1] || '';
    let h = Number(mCn[2]);
    mm = mCn[3] ? 30 : 0;
    if (period === '下午' || period === '傍晚' || period === '晚上' || period === '夜里') {
      if (h < 12) h += 12;
    } else if (period === '中午') {
      if (h <= 2) h += 12;
    } else if (period === '早上' || period === '上午') {
      if (h === 12) h = 0;
    }
    hh = h;
  }

  if (hh !== null) {
    let dt = zonedDate(y, mo, d, hh, mm);
    const explicitDate = Boolean(mDate || mWd) || dayOffset > 0;
    if (!explicitDate && dt.getTime() < Date.now()) {
      const p = partsOf(new Date(dt.getTime() + 86400000));
      dt = zonedDate(p.y, p.mo, p.d, hh, mm);
    }
    return dt.toISOString();
  }

  if (mDate || mWd || dayOffset > 0) return zonedDate(y, mo, d, 9, 0).toISOString();
  return null;
}
