import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const bool = (v, d = false) =>
  v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

/** 占位符 key(如 .env 模板里的 sk-xxxxxxxx)视为未配置 */
const apiKey = (process.env.LLM_API_KEY || '').trim();
const realApiKey = apiKey && !/x{4,}/i.test(apiKey) ? apiKey : '';

export const config = {
  root,
  dbPath: process.env.DB_PATH || path.resolve(root, 'data/todos.db'),
  tz: process.env.TZ || 'Asia/Shanghai',

  llm: {
    enabled: Boolean(realApiKey),
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey: realApiKey,
    model: process.env.LLM_MODEL || 'deepseek-chat',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 60000),
    temperature: Number(process.env.LLM_TEMPERATURE || 0.1),
  },

  web: {
    host: process.env.WEB_HOST || '0.0.0.0',
    port: Number(process.env.WEB_PORT || 8080),
  },

  onebot: {
    enabled: bool(process.env.QQ_ENABLED, true),
    host: process.env.ONE_BOT_WS_HOST || '0.0.0.0',
    port: Number(process.env.ONE_BOT_WS_PORT || 3001),
    token: process.env.ONE_BOT_ACCESS_TOKEN || '',
    processAllGroup: bool(process.env.QQ_PROCESS_ALL_GROUP, false),
    // 群白名单:这些群的所有消息都处理(不受 @ 限制);留空则所有群都只处理 @机器人 的消息
    groupWhitelist: (process.env.QQ_GROUP_WHITELIST || '')
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  },

  wechat: {
    enabled: bool(process.env.WECHAT_ENABLED, true),
    puppet: process.env.WECHAT_PUPPET || 'wechaty-puppet-wechat4u',
    token: process.env.WECHAT_PUPPET_TOKEN || '',
    processAllGroup: bool(process.env.WECHAT_PROCESS_ALL_GROUP, false),
  },

  todo: {
    keywords: (process.env.TODO_KEYWORDS || '')
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean),
    replyConfirm: bool(process.env.REPLY_CONFIRM, false),
  },

  // Bark iOS 推送(如 https://api.day.app/你的密钥;留空则不推送)
  barkUrl: process.env.BARK_URL || '',

  // PushDeer 安卓推送(pushkey,留空则不推送)
  pushDeerKey: process.env.PUSHDEER_KEY || '',

  // 到期前提前提醒(分钟);0 = 不提前提醒,只到点提醒
  advanceMinutes: Number(process.env.REMIND_ADVANCE_MINUTES || 60),

  schedule: {
    // 每晚提醒第二天课程的时间(HH:MM)
    notifyTime: /^\d{1,2}:\d{2}$/.test(process.env.SCHEDULE_NOTIFY_TIME || '')
      ? process.env.SCHEDULE_NOTIFY_TIME
      : '21:00',
    // 全局默认开学日期(YYYY-MM-DD,第一周周一,可选);学生也可私聊单独设置
    semesterStart: /^\d{4}-\d{2}-\d{2}$/.test(process.env.SCHEDULE_SEMESTER_START || '')
      ? process.env.SCHEDULE_SEMESTER_START
      : '',
  },
};

/** 当前时间(带星期与 UTC 偏移),用于喂给 LLM 作为参考 */
export function nowLabel() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: config.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('weekday')} ${get('hour')}:${get('minute')}:${get('second')} ${get('timeZoneName')}`;
}
