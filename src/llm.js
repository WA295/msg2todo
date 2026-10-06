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
