import * as XLSX from 'xlsx';
import { replaceSchedule, upsertScheduleUser } from './db.js';

/** 东北大学(浑南校区)节次时刻表;其他学校可在此扩展 */
const TT = {
  第一节: [8, 30], 第二节: [9, 25], 第三节: [10, 30], 第四节: [11, 25],
  第五节: [14, 0], 第六节: [14, 55], 第七节: [16, 0], 第八节: [16, 55],
  第九节: [18, 30], 第十节: [19, 25], 第十一节: [20, 20], 第十二节: [21, 15],
};
const PERIOD_MIN = 90; // 按 2 小节 90 分钟
const DAY_MAP = { 星期一: 1, 星期二: 2, 星期三: 3, 星期四: 4, 星期五: 5, 星期六: 6, 星期日: 0 };

/** 解析一个课表单元格(多行文本)为课程条目 */
function parseCell(text) {
  const entries = [];
  let cur = null;
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const nameM = line.match(/^(.+?)\s+([A-Z]\d{5,7})\s*$/); // 课程名 + 代码
    if (nameM && nameM[2]) {
      cur = { name: nameM[1].trim(), weeks: [] };
      entries.push(cur);
      continue;
    }
    if (line.startsWith('[实]')) {
      cur = { name: line, weeks: [] };
      entries.push(cur);
      continue;
    }
    if (/^\d{1,2}(?:-\d{1,2})?周/.test(line) && cur) {
      const tokens = [...line.matchAll(/(\d{1,2}(?:-\d{1,2})?)周/g)].map((m) => m[1]);
      if (tokens.length) cur.weeks.push({ tokens, line });
    }
  }
  return entries;
}

/** 展开周次并按连续性合并:['4','7-8'] → [[4,4],[7,8]] */
function expandWeeks(tokens) {
  const spans = tokens
    .map((t) => {
      if (t.includes('-')) {
        const [a, b] = t.split('-').map(Number);
        return [a, b];
      }
      const n = Number(t);
      return [n, n];
    })
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    if (merged.length && s[0] <= merged[merged.length - 1][1] + 1) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], s[1]);
    } else {
      merged.push(s);
    }
  }
  return merged;
}

/** 从周次行提取教室 */
function roomOf(line) {
  let rest = line.includes('浑南校区') ? line.split('浑南校区')[1] : line;
  rest = rest
    .replace(/\s*计算机\d+(?:\(\d+\))?(?:\s*,\s*计算机\d+(?:\(\d+\))?)*\s*$/, '')
    .trim();
  return rest;
}

/** 解析 xlsx Buffer → msg2todo 课程数组 */
export function parseWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  if (!rows || rows.length < 3) throw new Error('文件内容为空');

  // 表头在第 2 行(index 1):找星期所在列
  const dayCols = {};
  (rows[1] || []).forEach((v, idx) => {
    const key = String(v ?? '').trim();
    if (DAY_MAP[key] !== undefined) dayCols[idx] = DAY_MAP[key];
  });
  if (!Object.keys(dayCols).length) throw new Error('未识别到星期表头,请确认是教务系统导出的课表');

  const items = [];
  for (let r = 2; r < 14 && r < rows.length; r++) {
    const label = String((rows[r] || [])[0] || '').trim();
    const t = TT[label];
    if (!t) continue;
    const startMin = t[0] * 60 + t[1];
    for (const idx of Object.keys(dayCols)) {
      const cell = rows[r]?.[Number(idx)];
      if (!cell) continue;
      for (const entry of parseCell(String(cell))) {
        if (!entry.weeks.length) continue;
        for (const { tokens, line } of entry.weeks) {
          for (const [a, b] of expandWeeks(tokens)) {
            items.push({
              day: dayCols[idx], startMin, endMin: startMin + PERIOD_MIN,
              name: entry.name, location: roomOf(line), weekStart: a, weekEnd: b, parity: '',
            });
          }
        }
      }
    }
  }

  // 合并:同天同时同名同地点且周次连续
  items.sort((x, y) =>
    x.day - y.day || x.startMin - y.startMin ||
    x.name.localeCompare(y.name, 'zh') || x.location.localeCompare(y.location, 'zh') || x.weekStart - y.weekStart
  );
  const merged = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (
      last && last.day === it.day && last.startMin === it.startMin && last.endMin === it.endMin &&
      last.name === it.name && last.location === it.location && it.weekStart <= last.weekEnd + 1
    ) {
      last.weekEnd = Math.max(last.weekEnd, it.weekEnd);
    } else {
      merged.push({ ...it });
    }
  }
  return merged;
}

/** 处理学生发来的课表文件(.xlsx/.xls) */
export async function handleExcelImport(msg) {
  const files = (msg.files || []).filter((f) => /\.xlsx?$/i.test(f.name || ''));
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
    const items = parseWorkbook(buf);
    if (!items.length) {
      await reply('❌ 课表文件里没解析出课程,请确认是教务系统导出的标准课表\n也可以把课表文字直接发给我(发「课表帮助」查看格式)');
      return true;
    }
    const owner = `${msg.platform}:${msg.chatId}`;
    upsertScheduleUser(owner, { name: msg.sender });
    replaceSchedule(owner, items);
    console.log(`[课表导入] ${owner} 通过 Excel 导入 ${items.length} 节课`);
    await reply(`✅ 课表导入成功,共 ${items.length} 节课!\n发「我的课表」查看;有单双周课程记得发「开学日期 YYYY-MM-DD」`);
    return true;
  } catch (e) {
    console.warn('[课表导入] 失败:', e.message);
    await reply(`❌ 课表文件导入失败:${e.message}\n也可以把课表文字直接发给我(发「课表帮助」查看格式)`);
    return true;
  }
}
