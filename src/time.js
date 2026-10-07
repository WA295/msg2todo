import { config } from './config.js';

/** 把指定时区的本地时间(y/mo/d/hh/mi)转成 Date 对象 */
export function zonedDate(y, mo, d, hh, mi, tz = config.tz) {
  const guess = Date.UTC(y, mo - 1, d, hh, mi);
  const offsetAt = (t) => {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const p = dtf.formatToParts(new Date(t));
    const g = (k) => Number(p.find((x) => x.type === k)?.value);
    return t - Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  };
  let off = offsetAt(guess);
  off = offsetAt(guess + off); // 二次校正(处理夏令时边界)
  return new Date(guess + off);
}

/** 获取某个时刻在配置时区下的字段,wd: 0=周日 ~ 6=周六 */
export function partsOf(date, tz = config.tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  });
  const p = dtf.formatToParts(date);
  const g = (k) => Number(p.find((x) => x.type === k)?.value);
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: g('year'), mo: g('month'), d: g('day'),
    h: g('hour'), mi: g('minute'), s: g('second'),
    wd: wdMap[p.find((x) => x.type === 'weekday')?.value] ?? 0,
  };
}

export function nowParts() {
  return partsOf(new Date());
}

/** 把 ISO 时间格式化成用户可读字符串(今天/明天/M月d日 HH:mm) */
export function formatDue(iso, tz = config.tz) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = partsOf(d, tz);
  const hm = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
  const now = nowParts();
  const dayDiff = Math.round(
    (Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(now.y, now.mo - 1, now.d)) / 86400000
  );
  if (dayDiff === 0) return `今天 ${hm}`;
  if (dayDiff === 1) return `明天 ${hm}`;
  if (dayDiff === -1) return `昨天 ${hm}`;
  if (p.y === now.y) return `${p.mo}月${p.d}日 ${hm}`;
  return `${p.y}年${p.mo}月${p.d}日 ${hm}`;
}

/** 解析 datetime-local 输入 "YYYY-MM-DDTHH:mm" 或 "YYYY-MM-DD"(按配置时区) */
export function parseLocalInput(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return zonedDate(+y, +mo, +d, h ? +h : 9, mi ? +mi : 0).toISOString();
}

/** 某个日期(配置时区字段 y/mo/d)所在周的周一 */
export function mondayOf(y, mo, d) {
  const dt = Date.UTC(y, mo - 1, d);
  const back = (new Date(dt).getUTCDay() + 6) % 7; // 距周一的天数
  const nd = new Date(dt - back * 86400000);
  return { y: nd.getUTCFullYear(), mo: nd.getUTCMonth() + 1, d: nd.getUTCDate() };
}

/** 计算某天是开学后的第几周(开学日期所在周为第 1 周);未设置开学日期返回 null */
export function weekOf(parts, semesterStart) {
  const m = String(semesterStart || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const sm = mondayOf(+m[1], +m[2], +m[3]);
  const cm = mondayOf(parts.y, parts.mo, parts.d);
  const diff = Math.round((Date.UTC(cm.y, cm.mo - 1, cm.d) - Date.UTC(sm.y, sm.mo - 1, sm.d)) / 86400000);
  return Math.floor(diff / 7) + 1;
}

/** 距目标日期还有多少天(负数=已过) */
export function daysUntil(targetStr, fromParts) {
  const m = String(targetStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const p = fromParts || partsOf(new Date());
  return Math.round(
    (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(p.y, p.mo - 1, p.d)) / 86400000
  );
}

/** 某个日期所在周的周一 'YYYY-MM-DD' */
export function weekMondayStr(parts) {
  const p = parts || partsOf(new Date());
  const m = mondayOf(p.y, p.mo, p.d);
  return `${m.y}-${String(m.mo).padStart(2, '0')}-${String(m.d).padStart(2, '0')}`;
}

/** parts 转 'YYYY-MM-DD' */
export function partsToStr(p) {
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
