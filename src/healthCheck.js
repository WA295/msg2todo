import { liveStatus } from './events.js';
import { sendBark, sendPushDeer } from './notify.js';

let timer = null;
let lastQq = null;

/** 健康自检:QQ 掉线/恢复时推 Bark 通知管理员(每 5 分钟检查一次) */
export function startHealthCheck() {
  console.log('[健康] 自检已启用(QQ 掉线将告警管理员)');
  timer = setInterval(check, 5 * 60 * 1000);
  check();
}

export function stopHealthCheck() {
  if (timer) clearInterval(timer);
}

function check() {
  const qq = liveStatus.qq;
  if (lastQq === null) {
    lastQq = qq;
    return;
  }
  if (qq === lastQq) return;
  if (qq === 'off') {
    console.warn('[健康] QQ 机器人掉线,已告警管理员');
    sendBark('🚨 QQ 机器人掉线', '机器人连接已断开,QQ 提醒暂停(网页/App/Bark 推送不受影响)。请重新扫码登录。');
    sendPushDeer('🚨 QQ 机器人掉线', '机器人连接已断开,请重新扫码登录');
  } else if (lastQq === 'off') {
    console.log('[健康] QQ 机器人已恢复');
    sendBark('✅ QQ 机器人已恢复', '机器人重新上线,提醒恢复正常。');
  }
  lastQq = qq;
}
