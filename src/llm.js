import { config, nowLabel } from './config.js';

const SYSTEM_PROMPT = `你是一个待办事项提取助手。用户会给你一条聊天消息,你需要判断它是否包含需要记录的待办事项,并提取结构化信息。

判断规则:
1. isTodo 为 true 当且仅当消息明确表达了「用户需要记住、或需要在某个时间点去做的事情」,例如:开会、交作业、还书、买东西、回电话、提交材料、赴约、取快递等。
2. 纯闲聊、问候、疑问、陈述事实(没有行动意图)一律 isTodo=false。
3. title 要简洁、尽量动词开头,保留关键信息(人名、事件、地点),去掉"提醒我/记得/帮我"这类前缀。
4. dueAt:消息里有时间就输出 ISO 8601 格式,必须以 +08:00 时区偏移输出北京时间(如 2026-10-07T15:00:00+08:00),绝对禁止输出 Z、UTC 或 00:00 偏移;没有时间则为 null。用户说"明天/下周五"等相对时间时,以给出的当前时间为基准推算。只有时间段没有具体日期(如"下午3点"),默认当天,若当天已过则次日。
5. priority:根据紧迫程度判断,只能是 high / medium / low,默认 medium。
6. notes:需要补充的说明(地点、对象、上下文),没有则为空字符串。

只输出一个 JSON 对象,不要输出任何其他文字。`;

export async function extractTodoWithLLM(text) {
  const url = `${config.llm.baseUrl}/chat/completions`;
  const body = {
    model: config.llm.model,
    temperature: config.llm.temperature,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `当前时间:${nowLabel()}\n聊天消息:「${text}」\n\n请输出 JSON:{"isTodo":布尔值,"title":字符串,"dueAt":ISO8601字符串或null,"priority":"high|medium|low","notes":字符串}`,
      },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    if (!content) throw new Error('LLM 返回为空');
    return normalize(parseJSONLoose(content));
  } finally {
    clearTimeout(timer);
  }
}

function parseJSONLoose(s) {
  const t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('无法解析 LLM 输出');
  }
}

function normalize(obj) {
  const due = validDate(obj.dueAt);
  return {
    isTodo: obj.isTodo === true || obj.isTodo === 'true' || obj.isTodo === 1,
    title: String(obj.title || '').trim(),
    dueAt: due,
    priority: ['high', 'medium', 'low'].includes(obj.priority) ? obj.priority : 'medium',
    notes: String(obj.notes || '').trim(),
  };
}

function validDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const SCHEDULE_SYSTEM_PROMPT = `你是一个课表解析助手。用户发来几行课表文本,每行通常包含:星期、上课时间(如 08:00-09:40)、课程名,可能还有地点、周次范围(如 1-16周)、单双周(单周/双周)。

请把每一节课解析成 JSON,规则:
1. day: 0=周日,1=周一,2=周二,3=周三,4=周四,5=周五,6=周六。
2. start / end: "HH:MM" 24 小时制字符串,精确到分钟。
3. weekStart / weekEnd: 起止周次数字;没写周次则为 null(表示每周都上)。
4. parity: 单周="odd",双周="even",没有则为空字符串 ""。
5. location: 地点;没有则为空字符串 ""。
6. name: 课程名,不要包含时间/地点/周次信息。
7. 无法判断某一行是不是课程时跳过它。

只输出一个 JSON 对象,格式:{"items":[{"day":1,"start":"08:00","end":"09:40","name":"高等数学","location":"一教101","weekStart":null,"weekEnd":null,"parity":""}]}`;

/** LLM 解析课表文本 → 结构化课程数组(失败抛错) */
export async function extractScheduleWithLLM(text) {
  const url = `${config.llm.baseUrl}/chat/completions`;
  const body = {
    model: config.llm.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SCHEDULE_SYSTEM_PROMPT },
      { role: 'user', content: `课表文本:\n${text}` },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    if (!content) throw new Error('LLM 返回为空');
    const obj = parseJSONLoose(content);
    return (Array.isArray(obj.items) ? obj.items : []).map(normalizeScheduleItem).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeScheduleItem(it) {  const day = Number(it.day);
  const s = String(it.start || '').match(/^(\d{1,2}):(\d{2})$/);
  const e = String(it.end || '').match(/^(\d{1,2}):(\d{2})$/);
  const name = String(it.name || '').trim();
  if (![0, 1, 2, 3, 4, 5, 6].includes(day) || !s || !e || !name) return null;
  const startMin = Number(s[1]) * 60 + Number(s[2]);
  const endMin = Number(e[1]) * 60 + Number(e[2]);
  if (endMin <= startMin || endMin > 24 * 60) return null;
  const ws = Number(it.weekStart);
  const we = Number(it.weekEnd);
  return {
    day,
    startMin,
    endMin,
    name,
    location: String(it.location || '').trim(),
    weekStart: ws > 0 ? ws : null,
    weekEnd: we > 0 ? we : null,
    parity: ['odd', 'even'].includes(it.parity) ? it.parity : '',
  };
}

/** 视觉模型解析课表图片(base64)→ 结构化课程数组 */
export async function extractScheduleFromImage(base64, mimeType = 'image/jpeg') {
  if (!config.llm.enabled) {
    throw new Error('图片识别需要配置支持看图的模型:请在 .env 设置 LLM_API_KEY 与 LLM_VISION_MODEL(如 qwen-vl-max / glm-4v / gpt-4o)');
  }
  const url = `${config.llm.baseUrl}/chat/completions`;
  const body = {
    model: config.llm.visionModel,
    temperature: 0,
    messages: [
      { role: 'system', content: SCHEDULE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是学生课表的图片(教务系统截图或拍照)。请识别其中所有课程并输出 JSON。星期通常在表头(周一~周日),节次/时间通常在左侧一列或每个格子里。看不清的字段留空,不要臆造。' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`视觉模型 HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    if (!content) throw new Error('视觉模型返回为空');
    const obj = parseJSONLoose(content);
    return (Array.isArray(obj.items) ? obj.items : []).map(normalizeScheduleItem).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

const COURIER_SYSTEM_PROMPT = `你是一个快递通知解析助手。用户发来一条快递到货通知(短信/平台消息),请提取:
1. code:取件码/提货码/取件号(如 8-1234、A12-3、6位数字),没有则为空字符串
2. location:驿站/柜子/代收点(如 丰巢、菜鸟驿站、兔喜、妈妈驿站),没有则空字符串
3. company:快递公司或平台(京东/顺丰/中通/圆通/申通/韵达/极兔/邮政/百世/德邦/菜鸟/淘宝/拼多多等),没有则空字符串

只输出一个 JSON 对象:{"code":"","location":"","company":""}`;

/** LLM 解析快递通知(规则失败时兜底) */
export async function extractCourierWithLLM(text) {
  const url = `${config.llm.baseUrl}/chat/completions`;
  const body = {
    model: config.llm.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: COURIER_SYSTEM_PROMPT },
      { role: 'user', content: `快递通知:\n${text}` },
    ],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    const obj = parseJSONLoose(content);
    return {
      code: String(obj.code || '').trim().slice(0, 30),
      location: String(obj.location || '').trim().slice(0, 30),
      company: String(obj.company || '').trim().slice(0, 20),
    };
  } finally {
    clearTimeout(timer);
  }
}
