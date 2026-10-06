import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { handleIncoming } from './todo.js';
import { setStatus } from './events.js';

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
    // 令牌校验:Authorization: Bearer xxx 或 ?access_token=xxx
    if (config.onebot.token) {
      const auth = req.headers['authorization'] || '';
      const queryToken = new URL(req.url, 'http://localhost').searchParams.get('access_token') || '';
      if (auth !== `Bearer ${config.onebot.token}` && queryToken !== config.onebot.token) {
        console.warn('[QQ] 拒绝未授权连接');
        ws.close(4001, 'unauthorized');
        return;
      }
    }

    console.log('[QQ] 机器人已连接');
    botConnections++;
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
  if (state.selfId !== null && senderId === String(state.selfId)) return; // 自己的消息

  const { text, mentioned } = parseMessage(data.message, state.selfId);
  if (!text) return;

  const isGroup = messageType === 'group';
  const senderName = data.sender?.card || data.sender?.nickname || senderId;
  const chatName = isGroup ? `群:${data.group_id}` : senderName;

  if (isGroup) {
    const inWhitelist = config.onebot.groupWhitelist.includes(String(data.group_id));
    if (!config.onebot.processAllGroup && !inWhitelist && !mentioned) return;
  }

  handleIncoming({
    platform: 'qq',
    chatId: String(isGroup ? data.group_id : senderId),
    chatName,
    sender: senderName,
    text,
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
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg?.type === 'text') text += seg.data?.text ?? '';
      if (seg?.type === 'at' && String(seg.data?.qq) === String(selfId)) mentioned = true;
    }
  } else if (typeof message === 'string') {
    if (selfId !== null) mentioned = message.includes(`[CQ:at,qq=${selfId}]`);
    text = message.replace(/\[CQ:[^\]]+\]/g, '').trim();
  }
  return { text: text.trim(), mentioned };
}

function sendAction(ws, state, action, params) {
  const echo = `echo_${++state.echoSeq}`;
  ws.send(JSON.stringify({ action, params, echo }));
  return echo;
}
