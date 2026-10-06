import { EventEmitter } from 'node:events';

/** 全局事件:数据/状态变更时广播给 Web 看板 (SSE) */
export const events = new EventEmitter();

/**
 * 运行状态快照(看板初始化时通过 /api/status 读取):
 *   qq:   'on' | 'off'
 *   wechat: 'off' | 'connecting' | 'scanning' | 'on'
 *   wechatName: 登录昵称
 */
export const liveStatus = { qq: 'off', wechat: 'off', wechatName: '' };

export function setStatus(patch) {
  Object.assign(liveStatus, patch);
  events.emit('status', { ...liveStatus });
}
