import { db } from './db.js';
import { startWeb } from './web.js';
import { startOneBot } from './onebot.js';
import { startWechat } from './wechat.js';
import { startNotifier, stopNotifier } from './notify.js';
import { startScheduleReminder, stopScheduleReminder } from './scheduleReminder.js';

/** 启动全部服务,返回句柄(供停止时使用)。CLI 与桌面版共用。 */
export function startAll() {
  const handles = {};
  handles.web = startWeb();
  handles.onebot = startOneBot();
  startWechat().then((bot) => {
    handles.wechat = bot;
  });
  startNotifier();
  startScheduleReminder();
  return handles;
}

/** 停止全部服务 */
export async function stopAll(handles) {
  stopNotifier();
  stopScheduleReminder();
  if (handles?.wechat?.stop) {
    try { await handles.wechat.stop(); } catch (e) { console.warn('[停止] 微信:', e.message); }
  }
  if (handles?.onebot?.close) {
    try { handles.onebot.close(); } catch (e) { console.warn('[停止] QQ:', e.message); }
  }
  if (handles?.web?.close) {
    try { handles.web.close(); } catch (e) { console.warn('[停止] 看板:', e.message); }
  }
  try { db.close(); } catch {}
}
