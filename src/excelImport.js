import * as XLSX from 'xlsx';
import { replaceSchedule, upsertScheduleUser } from './db.js';
import { extractScheduleFromImage } from './llm.js';

/** 按文件头判断图片类型,返回 mime 或 null */
export function imageMime(buf) {
  const b = buf;
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** 课表上传统一入口:图片 → 视觉识别;表格 → 解析 */
export async function parseScheduleUpload(buf) {
  const mime = imageMime(buf);
  if (mime) return await extractScheduleFromImage(buf.toString('base64'), mime);
  return parseWorkbook(buf);
}

/**
 * 课表文件解析(兼容多种教务系统导出格式)
 *  - 网格课表:表头是星期(第一行/任意行),左侧是节次或时间,格子里是课程
 *  - 列表课表:每行一节课,列为 课程名称/星期/节次(时间)/周次/地点
 *  - 节次写法:第1节 / 1-2节 / 第一节 / 08:00-09:40 …
 *  - 周次写法:1-16周 / 1,3,5 / 单周 / 双周 / (1-16周)
 *  - 文件类型:.xlsx / .xls / .csv
 */

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
// 默认节次起始时刻(无明确时间时使用;东北大学样式的“第X节”为 90 分钟大节)
const PERIOD_START = [
  [8, 30], [9, 25], [10, 30], [11, 25], [14, 0], [14, 55],
  [16, 0], [16, 55], [18, 30], [19, 25], [20, 20], [21, 15],
].map(([h, m]) => h * 60 + m);
const SINGLE_MIN = 45;

/** 星期 → 0(周日)~6(周六);无法识别返回 null */
function dayIndex(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/(?:星期|周)\s*([一二三四五六日天1-7])/);
  if (m) {
    const c = m[1];
    if (c === '日' || c === '天' || c === '7') return 0;
    if ('一二三四五六'.includes(c)) return '一二三四五六'.indexOf(c) + 1;
    return Number(c) % 7;
  }
  if (/^[1-7]$/.test(s)) return Number(s) % 7;
  const en = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 }[s.slice(0, 3).toLowerCase()];
  return en === undefined ? null : en;
}

/** "08:00-09:40" / "8:00~9:40" / "08.00—09.40" → [startMin, endMin] */
function timeRangeOf(s) {
  const m = String(s).match(/(\d{1,2})\s*[:：.时]\s*(\d{1,2})?\s*[-~—－至到]\s*(\d{1,2})\s*[:：.时]\s*(\d{1,2})?/);
  if (!m) return null;
  const a = Number(m[1]) * 60 + Number(m[2] || 0);
  const b = Number(m[3]) * 60 + Number(m[4] || 0);
  return b > a && a >= 0 && b <= 24 * 60 ? [a, b] : null;
}

function periodNum(tok) {
  const s = String(tok).trim();
  if (CN_NUM[s] !== undefined) return CN_NUM[s];
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 行标签/节次字符串 → [startMin, endMin] */
function periodRange(label) {
  const t = String(label ?? '');
  const tr = timeRangeOf(t);
  if (tr) return tr;

  // 东北大学样式:单独的“第X节”= 90 分钟大节
  const big = t.match(/^第\s*([一二三四五六七八九十]{1,3})\s*节\s*$/);
  if (big && CN_NUM[big[1]]) {
    const st = PERIOD_START[CN_NUM[big[1]] - 1];
    if (st != null) return [st, st + 90];
  }

  // 通用:第1-2节 / 1-2节 / 第3节 / 1、2节
  const m = t.match(/(\d{1,2}|[一二三四五六七八九十]{1,3})\s*(?:[-~—－至到,,、]\s*(\d{1,2}|[一二三四五六七八九十]{1,3}))?\s*节/);
  if (m) {
    const a = periodNum(m[1]);
    if (a) {
      const b = m[2] ? periodNum(m[2]) : a;
      const ai = Math.min(Math.max(a, 1), PERIOD_START.length);
      const bi = Math.min(Math.max(b || a, 1), PERIOD_START.length);
      return [PERIOD_START[ai - 1], PERIOD_START[bi - 1] + SINGLE_MIN];
    }
  }
  return null;
}

/** 周次文本 → { tokens:['1-16','3'], parity:''|'odd'|'even' } */
function parseWeeks(s) {
  const t = String(s || '');
  let parity = '';
  if (/单/.test(t) && !/双/.test(t)) parity = 'odd';
  else if (/双/.test(t)) parity = 'even';
  const tokens = [];
  for (const m of t.matchAll(/(\d{1,2})(?:\s*[-~—－至到]\s*(\d{1,2}))?/g)) {
    const a = Number(m[1]);
    if (a < 1 || a > 30) continue;
    if (m[2]) {
      const b = Math.min(Number(m[2]), 30);
      tokens.push(`${a}-${Math.max(a, b)}`);
    } else {
      tokens.push(String(a));
    }
  }
  if (!tokens.length && parity) tokens.push('1-16'); // “单周/双周”但没写周次 → 默认 1-16
  return { tokens, parity };
}

/** 展开周次并合并连续区间:['4','7-8'] → [[4,4],[7,8]] */
function expandWeeks(tokens) {
  const spans = (tokens || [])
    .map((t) => {
      if (String(t).includes('-')) {
        const [a, b] = String(t).split('-').map(Number);
        return [a, b];
      }
      const n = Number(t);
      return [n, n];
    })
    .filter(([a]) => Number.isFinite(a))
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    if (merged.length && s[0] <= merged[merged.length - 1][1] + 1) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], s[1]);
    } else {
      merged.push([s[0], s[1]]);
    }
  }
  return merged;
}

const isWeekLine = (l) =>
  /周/.test(l) || /^\s*\d{1,2}\s*(?:[-~—－至到]\s*\d{1,2})?\s*(?:[,,、]\s*\d{1,2}\s*(?:[-~—－]\s*\d{1,2})?)*\s*$/.test(l);
const isRoomLine = (l) =>
  /(楼|教室|实验室|机房|体育馆|操场|报告厅|校区|教\s?\d|[A-D]\s?\d{2,4}|\d{1,2}\s*[-—]\s*\d{2,4}|\d+号楼)/.test(l);

/** 网格里的一个单元格 → 若干课程条目 */
function parseCellText(text) {
  const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let cur = null;
  const newCourse = (l) => ({ name: l.replace(/\s+[A-Z0-9]{4,}\s*$/, '').trim(), weeks: [], parity: '', room: '' });
  for (const l of lines) {
    if (!cur) { cur = newCourse(l); if (cur.name) out.push(cur); continue; } // 第一行永远是课程名
    if (isWeekLine(l)) {
      const w = parseWeeks(l);
      cur.weeks.push(...w.tokens);
      if (w.parity) cur.parity = w.parity;
      continue;
    }
    if (isRoomLine(l) && !cur.room) { cur.room = l; continue; }
    cur = newCourse(l);
    if (cur.name) out.push(cur);
  }
  return out;
}

function rowsOf(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' })
    .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '').trim()) : []));
}

function mergeItems(items) {
  items.sort((x, y) =>
    x.day - y.day || x.startMin - y.startMin ||
    x.name.localeCompare(y.name, 'zh') || (x.location || '').localeCompare(y.location || '', 'zh') || x.weekStart - y.weekStart
  );
  const merged = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (
      last && last.day === it.day && last.startMin === it.startMin && last.endMin === it.endMin &&
      last.name === it.name && (last.location || '') === (it.location || '') &&
      last.parity === it.parity && it.weekStart <= last.weekEnd + 1
    ) {
      last.weekEnd = Math.max(last.weekEnd, it.weekEnd);
    } else {
      merged.push({ ...it });
    }
  }
  return merged;
}

/** 网格课表:找到含 >=2 个星期表头的行作为表头 */
function tryGrid(rows) {
  let headerRow = -1;
  let dayCols = {};
  const limit = Math.min(rows.length, 12);
  for (let i = 0; i < limit; i++) {
    const cols = {};
    (rows[i] || []).forEach((v, idx) => { const d = dayIndex(v); if (d !== null) cols[idx] = d; });
    if (Object.keys(cols).length >= 2 && Object.keys(cols).length > Object.keys(dayCols).length) {
      headerRow = i;
      dayCols = cols;
    }
  }
  if (headerRow < 0) return [];
  const firstDayCol = Math.min(...Object.keys(dayCols).map(Number));
  const items = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const label = row.slice(0, firstDayCol).join(' ').trim() || row[0] || '';
    const range = periodRange(label);
    if (!range) continue;
    for (const [idx, day] of Object.entries(dayCols)) {
      const cell = row[Number(idx)];
      if (!cell) continue;
      for (const c of parseCellText(cell)) {
        if (!c.name) continue;
        const weeks = c.weeks.length ? c.weeks : ['1-16'];
        for (const [a, b] of expandWeeks(weeks)) {
          items.push({ day, startMin: range[0], endMin: range[1], name: c.name, location: c.room || '', weekStart: a, weekEnd: b, parity: c.parity || '' });
        }
      }
    }
  }
  return items;
}

function findCol(header, keys) {
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i] || '');
    if (h && keys.some((k) => h.includes(k))) return i;
  }
  return -1;
}

/** 列表课表:每行一节课 */
function tryList(rows) {
  let headerRow = -1;
  let map = null;
  const limit = Math.min(rows.length, 12);
  for (let i = 0; i < limit; i++) {
    const h = rows[i] || [];
    const nameCol = findCol(h, ['课程名称', '课程名', '课程', '名称', '教学班']);
    const dayCol = findCol(h, ['星期', '周几', '上课星期', '星期几']);
    const perCol = findCol(h, ['节次', '节数', '上课时间', '时间', '节']);
    if (nameCol >= 0 && (dayCol >= 0 || perCol >= 0)) {
      headerRow = i;
      map = {
        nameCol, dayCol, perCol,
        weekCol: findCol(h, ['周次', '周数', '上课周', '起止周', '周']),
        roomCol: findCol(h, ['上课地点', '地点', '教室', '场地']),
      };
      break;
    }
  }
  if (headerRow < 0 || !map || map.nameCol < 0) return [];

  const items = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const name = String(row[map.nameCol] || '').trim();
    if (!name || /^(课程|合计|备注)/.test(name)) continue;

    let range = map.perCol >= 0 ? periodRange(row[map.perCol]) : null;
    let day = map.dayCol >= 0 ? dayIndex(row[map.dayCol]) : null;
    // 兜底:在整行里找时间/节次与星期(应对合并列或列名不同)
    if (!range) { for (const c of row) { const t = timeRangeOf(c) || periodRange(c); if (t) { range = t; break; } } }
    if (day === null) { for (const c of row) { const d = dayIndex(c); if (d !== null) { day = d; break; } } }
    if (!range || day === null) continue;

    const wkRaw = map.weekCol >= 0 ? row[map.weekCol] : '';
    const w = wkRaw ? parseWeeks(wkRaw) : { tokens: ['1-16'], parity: '' };
    const room = map.roomCol >= 0 ? String(row[map.roomCol] || '').trim() : '';
    for (const [a, b] of expandWeeks(w.tokens.length ? w.tokens : ['1-16'])) {
      items.push({ day, startMin: range[0], endMin: range[1], name, location: room, weekStart: a, weekEnd: b, parity: w.parity || '' });
    }
  }
  return items;
}

/** 解析 xlsx / xls / csv Buffer → 课程数组 */
export function parseWorkbook(buf) {
  let wb;
  try {
    wb = XLSX.read(buf, { type: 'buffer' });
  } catch {
    wb = XLSX.read(buf.toString('utf8'), { type: 'string' });
  }
  let items = [];
  for (const name of wb.SheetNames) {
    const rows = rowsOf(wb.Sheets[name]);
    if (rows.length < 2) continue;
    const grid = tryGrid(rows);
    items = grid.length ? grid : tryList(rows);
    if (items.length) { console.log(`[课表导入] 使用工作簿「${name}」,${grid.length ? '网格' : '列表'}格式,${items.length} 节`); break; }
  }
  if (!items.length) throw new Error('未识别到课表格式。支持:教务系统导出的「网格课表」或「课程列表」,也支持 .csv;若都不行,可直接把课表文字发给机器人');
  return mergeItems(items);
}

/** 处理学生发来的课表文件:表格(xlsx/xls/csv)或图片(jpg/png/webp/bmp/gif) */
export async function handleExcelImport(msg) {
  const files = (msg.files || []).filter((f) => /\.(xlsx?|csv|jpe?g|png|webp|bmp|gif)$/i.test(f.name || ''));
  if (!files.length) return false;
  const reply = async (t) => {
    if (typeof msg.reply === 'function') {
      try { await msg.reply(t); } catch (e) { console.warn('[课表导入] 回复失败:', e.message); }
    }
  };
  try {
    const file = files[0];
    if (!file.url) throw new Error('未获取到文件下载地址');
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = imageMime(buf);
    const items = mime ? await extractScheduleFromImage(buf.toString('base64'), mime) : parseWorkbook(buf);
    if (!items.length) {
      await reply(mime
        ? '❌ 图片里没识别出课程。可以:\n① 换一张更清晰的课表截图重发;\n② 用「豆包」等 AI 识别这张图,把识别出的课表文字直接粘贴发给我(格式:周一 08:00-09:40 高等数学 @一教101)'
        : '❌ 课表文件里没解析出课程,请确认是教务系统导出的课表\n也可以把课表文字直接发给我(发「课表帮助」查看格式)');
      return true;
    }
    const owner = `${msg.platform}:${msg.chatId}`;
    upsertScheduleUser(owner, { name: msg.sender });
    replaceSchedule(owner, items);
    console.log(`[课表导入] ${owner} 通过${mime ? '图片识别' : '表格解析'}导入 ${items.length} 节课`);
    await reply(`✅ 课表导入成功,共 ${items.length} 节课!\n发「我的课表」查看;有单双周课程记得发「开学日期 YYYY-MM-DD」`);
    return true;
  } catch (e) {
    console.warn('[课表导入] 失败:', e.message);
    await reply(`❌ 课表导入失败:${e.message}\n💡 如果是图片识别失败,可以用「豆包」等 AI 先识别这张图,再把课表文字粘贴发给我`);
    return true;
  }
}
