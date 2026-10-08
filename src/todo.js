import { config } from './config.js';
import { addTodo, addMessage } from './db.js';
import { extractTodoWithLLM } from './llm.js';
import { extractTodoWithRules } from './rules.js';
import { formatDue } from './time.js';
import { events } from './events.js';
import { handleScheduleCommand } from './schedule.js';
import { handlePomodoroCommand } from './pomodoro.js';
import { handleWeatherCommand } from './weather.js';
import { handleCountdownCommand } from './countdown.js';
import { handleSleepCommand } from './sleep.js';
import { handleExcelImport } from './excelImport.js';
import { handlePackageCommand } from './packages.js';

/**
 * 统一的消息处理管线
 * @param {object} msg
 * @param {string} msg.platform  'qq' | 'wechat'
 * @param {string} msg.chatId
 * @param {string} msg.chatName
 * @param {string} msg.sender   发送者昵称
 * @param {string} msg.text     消息文本
 * @param {boolean} [msg.isGroup]
 * @param {boolean} [msg.mentioned]
 * @param {(t: string) => Promise<any>|void} [msg.reply] 回复函数
 */
export async function handleIncoming(msg) {
  const text = (msg.text || '').trim();
  const hasFiles = (msg.files || []).length > 0;
  if (!text && !hasFiles) return null;

  addMessage({
    platform: msg.platform,
    chatId: msg.chatId,
    chatName: msg.chatName,
    sender: msg.sender,
    text,
  });

  // Excel 课表文件导入(优先级最高,发 xlsx 文件即导入)
  if (hasFiles) {
    if (await handleExcelImport(msg)) return null;
  }
  if (!text) return null;

  // 课表指令优先处理(「课表/我的课表/明天什么课」等),不进入待办管线
  if (await handleScheduleCommand(msg)) return null;

  // 倒计时指令(「倒计时 12月12日 四六级」等)
  if (await handleCountdownCommand(msg)) return null;

  // 睡觉提醒指令(「睡觉提醒 23:00」等)
  if (await handleSleepCommand(msg)) return null;

  // 快递指令(「快递 8-1234 丰巢」等)
  if (await handlePackageCommand(msg)) return null;

  // 番茄钟指令(「番茄 25」/「番茄统计」等)
  if (await handlePomodoroCommand(msg)) return null;

  // 天气指令(「天气」/「设置天气 沈阳」等)
  if (await handleWeatherCommand(msg)) return null;

  // 关键词预过滤
  const kw = config.todo.keywords;
  if (kw.length && !kw.some((k) => text.includes(k))) return null;

  // 提取:LLM 优先,失败/未配置时回退到本地规则
  let result = null;
  let method = 'rules';
  if (config.llm.enabled) {
    try {
      result = await extractTodoWithLLM(text);
      method = 'llm';
    } catch (e) {
      console.warn('[提取] LLM 调用失败,回退到本地规则:', e.message);
    }
  }
  if (!result) result = extractTodoWithRules(text);

  if (!result.isTodo || !result.title) return null;

  const todo = addTodo({
    title: result.title,
    dueAt: result.dueAt,
    priority: result.priority,
    notes: result.notes,
    source: msg.platform,
    chatName: msg.chatName,
    senderName: msg.sender,
    owner: `${msg.platform}:${msg.chatId}`,
  });

  console.log(
    `[待办] 新增 #${todo.id} 「${todo.title}」${todo.due_at ? ` @ ${formatDue(todo.due_at)}` : ''} (${msg.platform}/${msg.chatName}/${msg.sender}, ${method})`
  );
  events.emit('new-todo', { todo, platform: msg.platform, chatName: msg.chatName });

  if (config.todo.replyConfirm && typeof msg.reply === 'function') {
    const due = formatDue(todo.due_at);
    const line = `✅ 已记下待办:${todo.title}${due ? ` · ${due}` : ''}${todo.priority === 'high' ? ' · 🔥高优先级' : ''}`;
    try {
      await msg.reply(line);
    } catch (e) {
      console.warn('[回复] 发送确认失败:', e.message);
    }
  }
  return todo;
}
