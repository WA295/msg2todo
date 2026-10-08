import { config } from './config.js';
import { events } from './events.js';
import { db } from './db.js';
import { formatDue } from './time.js';
import { sendWebPush } from './push.js';

const BARK_ROOT = 'https://api.day.app';
const PUSHDEER_ROOT = 'https://api2.pushdeer.com';

/** 从 BARK_URL 里提取密钥(支持完整 URL 或纯密钥) */
function keyFromUrl(url) {
  const m = String(url).match(/api\.day\.app\/([A-Za-z0-9]+)/) || String(url).match(/^([A-Za-z0-9]{10,})$/);
  return m ? m[1] : '';
}

export async function sendBark(title, body, keyOverride) {
  const src = keyOverride || config.barkUrl;
  if (!src) return;
  const key = keyFromUrl(src) || String(src).trim();
  if (!key) {
    console.warn('[推送] BARK_URL 格式不对,应为 https://api.day.app/你的密钥');
    return;
  }
  try {
    const res = await fetch(`${BARK_ROOT}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_key: key, title, body, group: 'msg2todo', sound: 'default' }),
    });
    if (!res.ok) console.warn('[推送] Bark 返回异常:', res.status);
  } catch (e) {
    console.warn('[推送] Bark 发送失败:', e.message);
  }
}

/** PushDeer(安卓)推送 */
export async function sendPushDeer(title, body, keyOverride) {
  const pushkey = keyOverride || config.pushDeerKey;
  if (!pushkey) return;
  try {
    const res = await fetch(`${PUSHDEER_ROOT}/message/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushkey, text: title, desp: body, type: 'markdown' }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || (data && data.code !== 0)) {
      console.warn('[推送] PushDeer 返回异常:', res.status, JSON.stringify(data));
    }
  } catch (e) {
    console.warn('[推送] PushDeer 发送失败:', e.message);
  }
}

/** 同时发往所有已配置的推送通道 */
function sendAll(title, body) {
  sendBark(title, body);
  sendPushDeer(title, body);
}

let dueTimer = null;

/** 启动推送:新待办即时推送 + 提前提醒 + 到期提醒(每 30 秒检查) */
export function startNotifier() {
  if (!config.barkUrl && !config.pushDeerKey) {
    console.log('[推送] 未配置 BARK_URL / PUSHDEER_KEY,手机推送未启用');
    return;
  }
  if (config.barkUrl) console.log('[推送] Bark(iOS) 已启用');
  if (config.pushDeerKey) console.log('[推送] PushDeer(安卓) 已启用');
  console.log(`[推送] 提前提醒:到期前 ${config.advanceMinutes} 分钟`);
  events.on('new-todo', ({ todo }) => {
    const due = formatDue(todo.due_at);
    sendAll('📝 新待办', `${todo.title}${due ? ` · ${due}` : ''}${todo.priority === 'high' ? ' · 🔥高优先级' : ''}`);
    sendWebPush(todo.owner || 'qq:1487138742', '📝 新待办', todo.title);
  });
  dueTimer = setInterval(checkReminders, 30000);
}

function checkReminders() {
  const now = Date.now();
  const advMs = config.advanceMinutes * 60 * 1000;
  const rows = db
    .prepare("SELECT * FROM todos WHERE status='open' AND due_at IS NOT NULL")
    .all();
  for (const t of rows) {
    const due = new Date(t.due_at).getTime();

    // 提前提醒:到期前 N 分钟(仍在未来)提醒一次
    if (advMs > 0 && !t.notified_adv_at && due > now && due - advMs <= now) {
      const remainMin = Math.max(1, Math.round((due - now) / 60000));
      const label = remainMin >= 60 ? `约 ${Math.round(remainMin / 60)} 小时` : `${remainMin} 分钟`;
      sendAll('⏰ 待办即将到期', `${t.title} · ${label}后到期 (${formatDue(t.due_at)})`);
      sendWebPush(t.owner || 'qq:1487138742', '⏰ 待办即将到期', `${t.title} · ${label}后到期`);
      db.prepare('UPDATE todos SET notified_adv_at = ? WHERE id = ?').run(new Date().toISOString(), t.id);
    }

    // 到期提醒:到期时刻前后 5 分钟内提醒一次
    if (!t.notified_at && due <= now && due > now - 5 * 60 * 1000) {
      sendAll('⏰ 待办已到期', t.title);
      sendWebPush(t.owner || 'qq:1487138742', '⏰ 待办已到期', t.title);
      db.prepare('UPDATE todos SET notified_at = ? WHERE id = ?').run(new Date().toISOString(), t.id);
    }
  }
}

export function stopNotifier() {
  if (dueTimer) clearInterval(dueTimer);
}
