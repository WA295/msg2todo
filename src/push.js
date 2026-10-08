import webpush from 'web-push';
import { config } from './config.js';
import { listPushSubscriptions, deletePushSubscription } from './db.js';

let webpushReady = false;
if (config.vapid.publicKey && config.vapid.privateKey) {
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  webpushReady = true;
}

/**
 * 发送 Web Push(浏览器/手机 PWA 原生通知,不依赖 QQ)
 * @param {string} owner 'qq:xxx' 或 'admin'
 */
export async function sendWebPush(owner, title, body) {
  if (!webpushReady) return;
  const subs = listPushSubscriptions(owner);
  for (const s of subs) {
    try {
      const sub = { endpoint: s.endpoint, keys: JSON.parse(s.keys) };
      await webpush.sendNotification(sub, JSON.stringify({ title, body }));
    } catch (e) {
      // 订阅失效(404/410)→ 清理
      if (e.statusCode === 404 || e.statusCode === 410) {
        deletePushSubscription(owner, s.endpoint);
      } else if (e.statusCode !== 200 && e.statusCode !== 201) {
        console.warn('[推送] WebPush 失败:', e.statusCode, e.message?.slice(0, 80));
      }
    }
  }
}
