import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { handleIncoming } from './todo.js';
import { setStatus } from './events.js';
import { getScheduleUser, getGroupWhitelist } from './db.js';

/**
 * OneBot v11 反向 WebSocket 服务端。
 * 在 LLOneBot / NapCat 中配置「反向 WebSocket」指向 ws://<主机>:<ONE_BOT_WS_PORT>
 */
export function startOneBot() {
  if (!config.onebot.enabled) {
    console.log('[QQ] 未启用 (QQ_ENABLED=false)');
    return;
  }
  const wss = new WebSocketServer({ host: config.onebot.host, port: config.onebot.port });

  wss.on('listening', () => {
    console.log(`[QQ] OneBot 反向WS已监听 ws://${config.onebot.host}:${config.onebot.port}`);
    if (config.onebot.token) console.log('[QQ] 已启用接入令牌,插件端需填写相同 token');
  });
  wss.on('error', (e) => console.error('[QQ] WebSocket 服务错误:', e.message));

  wss.on('connection', (ws, req) => {
    // 令牌校验:Authorization: Bearer xxx 或 ?access_token=xxx;本机回环连接免令牌
    if (config.onebot.token) {
      const ra = req.socket.remoteAddress || '';
      const isLoopback = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
      const auth = req.headers['authorization'] || '';
      const queryToken = new URL(req.url, 'http://localhost').searchParams.get('access_token') || '';
      if (!isLoopback && auth !== `Bearer ${config.onebot.token}` && queryToken !== config.onebot.token) {
        console.warn('[QQ] 拒绝未授权连接');
        ws.close(4001, 'unauthorized');
        return;
      }
    }

    console.log('[QQ] 机器人已连接');
    botConnections++;
    connectedBots.add(ws);
    setStatus({ qq: 'on' });
    const state = { selfId: null, echoSeq: 0 };
    // 主动查询登录信息(不依赖客户端上报 lifecycle 事件,重连时客户端可能不再发送)
    ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'get_login_info' }));

    ws.on('message', (data) => {
      try {
        onPayload(ws, state, JSON.parse(data.toString()));
      } catch (e) {
        console.warn('[QQ] 解析消息失败:', e.message);
      }
    });
    ws.on('close', () => {
      botConnections--;
      connectedBots.delete(ws);
      if (botConnections <= 0) {
        botConnections = 0;
        console.log('[QQ] 机器人已断开');
        setStatus({ qq: 'off' });
      }
    });
    ws.on('error', (e) => console.warn('[QQ] 连接错误:', e.message));
  });

  return wss;
}

const seenMessageIds = new Map(); // 消息去重(部分插件会重复上报)
let botConnections = 0; // 当前连接的机器人数量(状态显示用)
const connectedBots = new Set(); // 所有已连接的 WS(供定时任务主动发消息)

function isDuplicate(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  if (seenMessageIds.has(messageId)) return true;
  seenMessageIds.set(messageId, now);
  if (seenMessageIds.size > 1000) {
    for (const [k, v] of seenMessageIds) if (now - v > 600000) seenMessageIds.delete(k);
  }
  return false;
}

function onPayload(ws, state, data) {
  // lifecycle 上报 → 询问登录信息,拿到 self_id
  if (data.post_type === 'meta_event' && data.meta_event_type === 'lifecycle' && data.sub_type === 'enable') {
    ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'get_login_info' }));
    return;
  }
  if (data.echo === 'get_login_info' && data.status === 'ok') {
    state.selfId = data.data?.user_id ?? state.selfId;
    console.log(`[QQ] 登录成功,self_id=${state.selfId} (${data.data?.nickname || ''})`);
    return;
  }

  if (data.post_type !== 'message') return;
  if (isDuplicate(data.message_id)) return;

  const messageType = data.message_type;
  if (messageType !== 'private' && messageType !== 'group') return;

  const senderId = String(data.sender?.user_id ?? data.user_id ?? '');

  // 个人机器人模式:该连接的 QQ 号已登记为学生 → 所有消息归属这个学生自己
  const personal = state.selfId ? Boolean(getScheduleUser(`qq:${state.selfId}`)) : false;
  // 共享机器人:跳过自己的消息;个人机器人:自己的消息也处理(学生给自己发指令/转发消息)
  if (state.selfId !== null && senderId === String(state.selfId) && !personal) return;

  const { text, mentioned, files } = parseMessage(data.message, state.selfId);
  if (!text && !files.length) return;

  const isGroup = messageType === 'group';
  const senderName = data.sender?.card || data.sender?.nickname || senderId;
  const chatName = isGroup ? `群:${data.group_id}` : senderName;

  // 群白名单:优先用"用户自己设置的"(个人机器人→本人;共享机器人→发送者),没设则用全局
  if (isGroup) {
    const wlOwner = personal ? `qq:${state.selfId}` : `qq:${senderId}`;
    const userWl = getGroupWhitelist(wlOwner);
    const wl = userWl.length ? userWl : config.onebot.groupWhitelist;
    const inWhitelist = config.onebot.processAllGroup || wl.includes(String(data.group_id));
    if (!inWhitelist && !mentioned) return; // 不在白名单的群:仅 @机器人 才处理
  }

  handleIncoming({
    platform: 'qq',
    // 个人模式:所有消息归属学生本人(chatId = 学生自己的 QQ 号)
    chatId: personal ? String(state.selfId) : String(isGroup ? data.group_id : senderId),
    chatName,
    sender: senderName,
    text,
    files,
    isGroup,
    mentioned,
    reply: (t) => sendAction(ws, state, 'send_msg', {
      message_type: messageType,
      ...(isGroup ? { group_id: data.group_id } : { user_id: data.user_id }),
      message: [{ type: 'text', data: { text: t } }],
    }),
  }).catch((e) => console.error('[QQ] 处理消息出错:', e));
}

function parseMessage(message, selfId) {
  let text = '';
  let mentioned = false;
  const files = [];
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg?.type === 'text') text += seg.data?.text ?? '';
      if (seg?.type === 'at' && String(seg.data?.qq) === String(selfId)) mentioned = true;
      if (seg?.type === 'file') files.push({ name: seg.data?.name || seg.data?.file || '', url: seg.data?.url || '' });
    }
  } else if (typeof message === 'string') {
    if (selfId !== null) mentioned = message.includes(`[CQ:at,qq=${selfId}]`);
    text = message.replace(/\[CQ:[^\]]+\]/g, '').trim();
  }
  return { text: text.trim(), mentioned, files };
}

function sendAction(ws, state, action, params) {
  const echo = `echo_${++state.echoSeq}`;
  ws.send(JSON.stringify({ action, params, echo }));
  return echo;
}

/**
 * 主动给用户发私聊消息(课表提醒等定时任务用)。
 * @returns {boolean} 是否至少有一个可用连接收到
 */
export function sendQQPrivate(userId, text) {
  let sent = false;
  for (const ws of connectedBots) {
    if (ws.readyState !== 1) continue;
    try {
      if (!ws._obState) ws._obState = { echoSeq: 0 };
      ws.send(
        JSON.stringify({
          action: 'send_private_msg',
          params: { user_id: Number(userId), message: [{ type: 'text', data: { text } }] },
          echo: `echo_${++ws._obState.echoSeq}`,
        })
      );
      sent = true;
    } catch (e) {
      console.warn('[QQ] 发送私聊失败:', e.message);
    }
  }
  return sent;
}
