import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import QRCode from 'qrcode';
import { config } from './config.js';
import {
  db, listTodos, toggleTodo, deleteTodo, addTodo, stats,
  listScheduleUsers, listScheduleItems, clearSchedule, deleteScheduleItem, replaceSchedule,
  pomodoroTodayByOwner, getScheduleUser, upsertScheduleUser, getUserByToken, setWebToken, randomToken, getGroupWhitelist,
  getWeatherUser, startPomodoro, stopPomodoro, pomodoroStats, addCountdown, deleteCountdown, listCountdowns,
  upsertWeatherUser,
} from './db.js';
import { parseLocalInput, partsOf, weekOf, zonedDate, partsToStr, daysUntil } from './time.js';
import { buildDayText } from './schedule.js';
import { getWeather, formatWeather } from './weather.js';
import { parseScheduleUpload } from './excelImport.js';
import { events, liveStatus } from './events.js';
import { addPushSubscription, listPushSubscriptions, deletePushSubscription, listResources, addResource, deleteResource,
  addPackage, listPackages, markPackageDone, deletePackage, addPost, listPosts, deletePost,
  listPostsWithReplies, addPostReply, deletePostReply,
  addAnnouncement, listAnnouncements, deleteAnnouncement, dismissAnnouncement, listAnnouncementsFor,
  searchUsers, listFriends, listFriendRequests, sendFriendRequest, respondFriendRequest, removeFriend, areFriends,
  BOT_OWNER, addChatMessage, listChatMessages, markChatRead, listConversations, totalChatUnread } from './db.js';
import { handleIncoming } from './todo.js';
import { pushCountdownNow } from './countdown.js';
import { sendWebPush } from './push.js';
import { sendQQPrivate } from './onebot.js';
import { sendBark, sendPushDeer } from './notify.js';

const sseClients = new Set();
const sseOwners = new Map(); // SSE 连接 → owner(用于定向推送聊天消息)
let qrSvg = null;

function broadcast(event, payload) {
  const data = JSON.stringify(payload ?? {});
  for (const res of sseClients) {
    try {
      res.write(`event: ${event}\ndata: ${data}\n\n`);
    } catch {}
  }
}

/** 只推给某个 owner 的所有在线连接 */
function sendToOwner(owner, event, payload) {
  if (!owner) return;
  const data = JSON.stringify(payload ?? {});
  for (const res of sseClients) {
    if (sseOwners.get(res) === owner) {
      try { res.write(`event: ${event}\ndata: ${data}\n\n`); } catch {}
    }
  }
}

/** 机器人对话:复用 QQ 指令管线,把回复落库并通过 SSE 推回 App */
async function handleAppBot(me, text) {
  const qq = me.replace(/^qq:/, '');
  let replied = false;
  const reply = async (t) => {
    replied = true;
    const m = addChatMessage(BOT_OWNER, me, String(t));
    sendToOwner(me, 'chat', { peer: BOT_OWNER, message: m });
    return m;
  };
  try {
    await handleIncoming({ platform: 'qq', chatId: qq, chatName: 'App 聊天', sender: '我', text, reply });
  } catch (e) {
    console.warn('[机器人] 处理失败:', e.message);
  }
  if (!replied) {
    await reply(
      '我是 iTodo 机器人 🤖,可以帮你:\n' +
      '• 记待办:直接发「明天 10 点交作业」\n' +
      '• 课表:发「课表」「明天什么课」\n' +
      '• 番茄钟:发「番茄 25」\n' +
      '• 天气:发「天气」\n' +
      '• 倒计时:发「倒计时 12月12日 四六级」\n' +
      '• 快递:发「快递 8-1234 丰巢」'
    );
  }
}

// 数据变更 → 看板刷新
events.on('change', () => broadcast('update', {}));
// 天气更新 → 让在线客户端刷新天气卡片
events.on('weather', () => broadcast('weather', {}));
// 状态变更 → 看板状态条
events.on('status', (s) => broadcast('status', s));
// 微信扫码二维码
events.on('wechat-qr', async (qr) => {
  if (qr?.text) {
    try {
      qrSvg = await QRCode.toString(qr.text, {
        type: 'svg',
        margin: 1,
        width: 220,
        errorCorrectionLevel: 'M',
      });
    } catch {
      qrSvg = null;
    }
  } else {
    qrSvg = null;
  }
  broadcast('qr', { hasQr: Boolean(qrSvg) });
});

export function startWeb() {
  const app = express();
  app.use(express.json());

  // CORS:允许手机 App(电容壳,跨域来源)访问
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // 简单限流:每 IP 每分钟最多 300 次请求
  const rateMap = new Map();
  app.use('/api', (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let r = rateMap.get(ip);
    if (!r || now - r.t > 60000) {
      r = { count: 0, t: now };
      rateMap.set(ip, r);
    }
    r.count++;
    if (r.count > 300) return res.status(429).json({ error: '请求过于频繁,请稍后再试' });
    if (rateMap.size > 5000) rateMap.clear();
    next();
  });

  // 学生绑定:用自己的 QQ 号换取专属令牌(无需管理员密码)
  app.post('/api/bind', express.json(), (req, res) => {
    const qq = String(req.body?.qq || '').trim().replace(/\D/g, '');
    if (!/^\d{5,12}$/.test(qq)) return res.status(400).json({ error: 'QQ 号格式不对,请输入 5~12 位数字' });
    const owner = `qq:${qq}`;
    let u = getScheduleUser(owner);
    if (!u) u = upsertScheduleUser(owner, { name: `同学${qq.slice(-4)}` });
    if (!u.web_token) {
      setWebToken(owner, randomToken());
      u = getScheduleUser(owner);
    }
    res.json({ token: u.web_token, name: u.name, owner });
  });

  // 访问控制:管理员令牌(全局)或学生个人令牌;/api 接口需带 x-auth-token 或 ?token=
  app.use('/api', (req, res, next) => {
    const token = req.headers['x-auth-token'] || req.query.token;
    // 未配置管理员令牌(内网模式)= 一律按管理员
    if (!config.web.authToken) {
      req.user = { isAdmin: true, owner: null, name: '管理员' };
      return next();
    }
    if (token === config.web.authToken) {
      req.user = { isAdmin: true, owner: null, name: '管理员' };
      return next();
    }
    const u = getUserByToken(token);
    if (u) {
      req.user = { isAdmin: false, owner: u.owner, name: u.name || u.owner };
      return next();
    }
    res.status(401).json({ error: 'unauthorized' });
  });

  // 当前身份(用于管理员登录校验 + 前端显示)
  app.get('/api/me', (req, res) => {
    res.json({
      isAdmin: req.user.isAdmin,
      owner: req.user.owner || (req.user.isAdmin ? 'qq:1487138742' : null),
      name: req.user.name || '',
    });
  });

  // 待办列表(学生只看自己的;管理员看全部)
  app.get('/api/todos', (req, res) => {
    const status = ['open', 'done'].includes(req.query.status) ? req.query.status : 'all';
    const q = String(req.query.q || '').trim();
    const owner = req.user.isAdmin ? null : req.user.owner;
    const todos = listTodos({ status, q, owner });
    const st = req.user.isAdmin
      ? stats()
      : (() => {
          const rows = todos.filter((t) => t.status === 'open').length;
          const all = db.prepare('SELECT COUNT(*) c FROM todos WHERE owner = ?').get(req.user.owner).c;
          return { open: rows, done: Number(all) - rows, total: Number(all) };
        })();
    res.json({ todos, stats: st });
  });

  // 手动添加(学生只能给自己加)
  app.post('/api/todos', (req, res) => {
    const { title, dueLocal, priority, notes } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: '标题不能为空' });
    const dueAt = parseLocalInput(dueLocal);
    const todo = addTodo({
      title: String(title).trim(),
      dueAt,
      priority: ['high', 'medium', 'low'].includes(priority) ? priority : 'medium',
      notes: String(notes || '').trim(),
      source: 'manual',
      owner: req.user.isAdmin ? 'qq:1487138742' : req.user.owner,
    });
    res.json(todo);
  });

  // 勾选/取消勾选
  app.post('/api/todos/:id/toggle', (req, res) => {
    const todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(Number(req.params.id));
    if (!todo) return res.status(404).json({ error: '待办不存在' });
    if (!req.user.isAdmin && todo.owner !== req.user.owner) return res.status(403).json({ error: '无权操作' });
    const t = toggleTodo(Number(req.params.id));
    if (!t) return res.status(404).json({ error: '待办不存在' });
    res.json(t);
  });

  // 删除
  app.delete('/api/todos/:id', (req, res) => {
    const todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(Number(req.params.id));
    if (!todo) return res.status(404).json({ error: '待办不存在' });
    if (!req.user.isAdmin && todo.owner !== req.user.owner) return res.status(403).json({ error: '无权操作' });
    if (!deleteTodo(Number(req.params.id))) return res.status(404).json({ error: '待办不存在' });
    res.json({ ok: true });
  });

  // 运行状态快照
  app.get('/api/status', (req, res) => {
    res.json({ ...liveStatus, llm: config.llm.enabled, wechatEnabled: config.wechat.enabled });
  });

  // ── Web Push(App 原生推送)──
  // VAPID 公钥(前端订阅用)
  app.get('/api/push/vapid', (req, res) => {
    res.json({ publicKey: config.vapid.publicKey, enabled: Boolean(config.vapid.publicKey && config.vapid.privateKey) });
  });

  // 订阅:保存当前用户的推送订阅
  app.post('/api/push/subscribe', express.json(), (req, res) => {
    const sub = req.body?.subscription;
    if (!sub || !sub.endpoint || !sub.keys?.p256dh) return res.status(400).json({ error: '订阅数据无效' });
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    addPushSubscription(owner, sub, req.headers['user-agent'] || '');
    res.json({ ok: true, count: listPushSubscriptions(owner).length });
  });

  // 取消订阅
  app.post('/api/push/unsubscribe', express.json(), (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    deletePushSubscription(owner, String(req.body?.endpoint || ''));
    res.json({ ok: true });
  });

  // ── 番茄钟控制(App 内,替代 QQ 指令)──
  app.get('/api/pomodoro', (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const running = db.prepare("SELECT * FROM pomodoro WHERE owner = ? AND status = 'running'").get(owner);
    res.json({ running: running || null, stats: pomodoroStats(owner) });
  });

  app.post('/api/pomodoro/start', express.json(), (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const focus = Math.min(180, Math.max(1, Number(req.body?.focusMin) || 25));
    const rest = Math.min(60, Math.max(1, Number(req.body?.restMin) || 5));
    const rounds = Math.min(12, Math.max(1, Number(req.body?.rounds) || 1));
    startPomodoro({ owner, focusMin: focus, restMin: rest, rounds });
    res.json({ ok: true, focusMin: focus, restMin: rest, rounds });
  });

  app.post('/api/pomodoro/stop', (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    stopPomodoro(owner);
    res.json({ ok: true });
  });

  // ── 天气设置(App 内)──
  app.post('/api/weather/config', express.json(), (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const fields = {};
    if (req.body?.city !== undefined) fields.city = String(req.body.city).trim().slice(0, 20);
    if (/^\d{1,2}:\d{2}$/.test(String(req.body?.time || ''))) fields.notifyTime = req.body.time;
    if (req.body?.enabled !== undefined) fields.enabled = req.body.enabled ? 1 : 0;
    upsertWeatherUser(owner, fields);
    res.json({ ok: true, config: getWeatherUser(owner) });
  });

  // ── 倒计时管理(App 内)──
  app.post('/api/countdowns', express.json(), (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const title = String(req.body?.title || '').trim().slice(0, 30);
    const target = String(req.body?.target || '').trim();
    if (!title) return res.status(400).json({ error: '标题不能为空' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
    const [y, mo, d] = target.split('-').map(Number);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
      return res.status(400).json({ error: '日期无效' });
    }
    const id = addCountdown(owner, title, target);
    pushCountdownNow(owner, title, target);
    res.json({ ok: true, id });
  });

  app.delete('/api/countdowns/:id', (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const cd = db.prepare('SELECT * FROM countdowns WHERE id = ?').get(Number(req.params.id));
    if (!cd) return res.status(404).json({ error: '倒计时不存在' });
    if (!req.user.isAdmin && cd.owner !== owner) return res.status(403).json({ error: '无权操作' });
    deleteCountdown(Number(req.params.id));
    res.json({ ok: true });
  });

  // ── 睡觉提醒 / 课表提醒时间 / 开学日期 / 上课提醒开关(App 内)──
  app.post('/api/schedule/config', express.json(), (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const fields = {};
    if (/^\d{1,2}:\d{2}$/.test(String(req.body?.notifyTime || ''))) fields.notifyTime = req.body.notifyTime;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.semesterStart || ''))) fields.semesterStart = req.body.semesterStart;
    if (req.body?.classRemind !== undefined) fields.classRemind = req.body.classRemind ? 1 : 0;
    if (req.body?.sleepTime !== undefined) fields.sleepTime = String(req.body.sleepTime).trim();
    if (req.body?.sleepOff) fields.sleepTime = '';
    upsertScheduleUser(owner, fields);
    res.json({ ok: true });
  });

  // ── 手机推送绑定(App 内,替代「设置推送」指令)──
  app.post('/api/push/bind', express.json(), (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const raw = String(req.body?.key || '').trim();
    if (!raw) return res.status(400).json({ error: '请填写 Bark 地址或 PushDeer 的 PDU key' });
    let kind = '';
    let k = raw;
    if (/^PDU/i.test(raw) || /pushdeer/i.test(raw)) {
      kind = 'pushdeer';
      k = raw.replace(/^.*(PDU\w+).*$/i, '$1');
    } else if (raw.includes('api.day.app') || /^https?:\/\//i.test(raw)) {
      kind = 'bark';
    } else if (/^[A-Za-z0-9]{16,}$/.test(raw)) {
      kind = 'bark';
    }
    if (!kind) return res.status(400).json({ error: '无法识别推送密钥类型(Bark 地址或 PDU 开头的 PushDeer key)' });
    upsertScheduleUser(owner, { pushKind: kind, pushKey: k });
    res.json({ ok: true, kind });
  });

  app.post('/api/push/unbind', (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    upsertScheduleUser(owner, { pushKind: '', pushKey: '' });
    res.json({ ok: true });
  });

  // ── 学习资源(所有人可看;管理员可增删)──
  app.get('/api/resources', (req, res) => {
    res.json({ resources: listResources() });
  });

  app.post('/api/resources', express.json(), (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: '仅管理员可添加' });
    const { category, title, url, description } = req.body || {};
    if (!String(category || '').trim() || !String(title || '').trim()) return res.status(400).json({ error: '分类和标题必填' });
    if (!/^https?:\/\/.+/.test(String(url || ''))) return res.status(400).json({ error: '网址需以 http(s):// 开头' });
    const id = addResource({
      category: String(category).trim().slice(0, 20),
      title: String(title).trim().slice(0, 40),
      url: String(url).trim(),
      description: String(description || '').trim().slice(0, 100),
    });
    res.json({ ok: true, id });
  });

  app.delete('/api/resources/:id', (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: '仅管理员可删除' });
    if (!deleteResource(Number(req.params.id))) return res.status(404).json({ error: '资源不存在' });
    res.json({ ok: true });
  });

  // ── 快递(App 内)──
  app.get('/api/packages', (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    res.json({ packages: listPackages(owner) });
  });

  app.post('/api/packages', express.json(), (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const code = String(req.body?.code || '').trim().slice(0, 30);
    const location = String(req.body?.location || '').trim().slice(0, 30);
    const company = String(req.body?.company || '').trim().slice(0, 20);
    if (!code) return res.status(400).json({ error: '取件码不能为空' });
    const id = addPackage(owner, code, location, company);
    res.json({ ok: true, id });
  });

  app.post('/api/packages/:id/done', (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const p = db.prepare('SELECT * FROM packages WHERE id = ?').get(Number(req.params.id));
    if (!p) return res.status(404).json({ error: '快递不存在' });
    if (!req.user.isAdmin && p.owner !== owner) return res.status(403).json({ error: '无权操作' });
    markPackageDone(Number(req.params.id));
    res.json({ ok: true });
  });

  app.delete('/api/packages/:id', (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const p = db.prepare('SELECT * FROM packages WHERE id = ?').get(Number(req.params.id));
    if (!p) return res.status(404).json({ error: '快递不存在' });
    if (!req.user.isAdmin && p.owner !== owner) return res.status(403).json({ error: '无权操作' });
    deletePackage(Number(req.params.id));
    res.json({ ok: true });
  });

  // ── 留言板(所有人可见)──
  app.get('/api/posts', (req, res) => {
    const meOwner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const posts = listPostsWithReplies(100).map((p) => ({
      ...p,
      mine: req.user.isAdmin || p.owner === meOwner,
      replies: (p.replies || []).map((r) => ({ ...r, mine: req.user.isAdmin || r.owner === meOwner })),
    }));
    res.json({ posts });
  });

  app.post('/api/posts', express.json(), (req, res) => {
    const content = String(req.body?.content || '').trim().slice(0, 500);
    if (!content) return res.status(400).json({ error: '内容不能为空' });
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const name = req.user.isAdmin ? '管理员' : (req.user.name || '同学');
    addPost(owner, name, content);
    res.json({ ok: true });
  });

  app.delete('/api/posts/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
    if (!p) return res.status(404).json({ error: '留言不存在' });
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    if (!req.user.isAdmin && p.owner !== owner) return res.status(403).json({ error: '无权操作' });
    deletePost(Number(req.params.id));
    res.json({ ok: true });
  });

  // 回复某条留言
  app.post('/api/posts/:id/replies', express.json(), (req, res) => {
    const content = String(req.body?.content || '').trim().slice(0, 500);
    if (!content) return res.status(400).json({ error: '回复不能为空' });
    if (!db.prepare('SELECT id FROM posts WHERE id = ?').get(Number(req.params.id))) return res.status(404).json({ error: '留言不存在' });
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const name = req.user.isAdmin ? '管理员' : (req.user.name || '同学');
    addPostReply(Number(req.params.id), owner, name, content);
    res.json({ ok: true });
  });

  // 删除回复(本人或管理员)
  app.delete('/api/post-replies/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM post_replies WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '回复不存在' });
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    if (!req.user.isAdmin && row.owner !== owner) return res.status(403).json({ error: '无权操作' });
    deletePostReply(Number(req.params.id));
    res.json({ ok: true });
  });

  // ── 公告(所有人可看;管理员发布即全员广播)──
  app.get('/api/announcements', (req, res) => {
    res.json({ announcements: listAnnouncements(20) });
  });

  app.post('/api/announcements', express.json(), (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: '仅管理员可发公告' });
    const title = String(req.body?.title || '').trim().slice(0, 40);
    const content = String(req.body?.content || '').trim().slice(0, 500);
    if (!title || !content) return res.status(400).json({ error: '标题和内容必填' });
    addAnnouncement(title, content);
    // 广播给所有学生:QQ + Web Push + 已绑定的手机推送
    for (const u of listScheduleUsers()) {
      if (u.owner.startsWith('qq:')) sendQQPrivate(u.owner.slice(3), `📢 公告:${title}\n\n${content}`);
      sendWebPush(u.owner, `📢 ${title}`, content);
      if (u.push_kind === 'bark') sendBark(`📢 ${title}`, content, u.push_key);
      else if (u.push_kind === 'pushdeer') sendPushDeer(`📢 ${title}`, content, u.push_key);
    }
    console.log(`[公告] 「${title}」已广播给 ${listScheduleUsers().length} 人`);
    res.json({ ok: true });
  });

  app.delete('/api/announcements/:id', (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: '仅管理员可删' });
    if (!deleteAnnouncement(Number(req.params.id))) return res.status(404).json({ error: '公告不存在' });
    res.json({ ok: true });
  });

  // 用户点「确认」→ 该公告对本人隐藏(不影响其他人)
  app.post('/api/announcements/:id/dismiss', (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    dismissAnnouncement(owner, Number(req.params.id));
    res.json({ ok: true });
  });

  // ── 用户好友(用户之间互相添加)──
  const meOwner = (req) => (req.user.isAdmin ? 'qq:1487138742' : req.user.owner);

  app.get('/api/friends', (req, res) => {
    const me = meOwner(req);
    const u = getScheduleUser(me);
    const { incoming, outgoing } = listFriendRequests(me);
    res.json({ me: { owner: me, name: (u && u.name) || me }, friends: listFriends(me), incoming, outgoing });
  });

  app.get('/api/friends/search', (req, res) => {
    res.json({ users: searchUsers(meOwner(req), req.query.q) });
  });

  app.post('/api/friends/request', express.json(), (req, res) => {
    const r = sendFriendRequest(meOwner(req), String(req.body?.owner || '').trim());
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  app.post('/api/friends/:id/accept', (req, res) => {
    const r = respondFriendRequest(Number(req.params.id), meOwner(req), true);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  app.post('/api/friends/:id/reject', (req, res) => {
    const r = respondFriendRequest(Number(req.params.id), meOwner(req), false);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  app.delete('/api/friends/:id', (req, res) => {
    const r = removeFriend(Number(req.params.id), meOwner(req));
    if (r.error) return res.status(400).json(r);
    res.json(r);
  });

  // ── 聊天(好友私聊 + 机器人)──
  // 仅允许给好友发消息;机器人所有人可用
  const canChat = (me, peer) => peer === BOT_OWNER || areFriends(me, peer);

  app.get('/api/chat/conversations', (req, res) => {
    const me = meOwner(req);
    res.json({ me, conversations: listConversations(me), unread: totalChatUnread(me) });
  });

  app.get('/api/chat/:peer/messages', (req, res) => {
    const me = meOwner(req);
    const peer = String(req.params.peer);
    if (!canChat(me, peer)) return res.status(403).json({ error: '只能和好友聊天' });
    const messages = listChatMessages(me, peer, { sinceId: Number(req.query.since) || 0 });
    res.json({ messages });
  });

  app.post('/api/chat/:peer/messages', express.json(), (req, res) => {
    const me = meOwner(req);
    const peer = String(req.params.peer);
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: '消息不能为空' });
    if (text.length > 2000) return res.status(400).json({ error: '消息太长啦' });
    if (!canChat(me, peer)) return res.status(403).json({ error: '只能和好友聊天' });
    const message = addChatMessage(me, peer, text);
    sendToOwner(peer, 'chat', { peer: me, message });
    // 机器人:异步处理,回复通过 SSE 送达
    if (peer === BOT_OWNER) handleAppBot(me, text).catch((e) => console.warn('[机器人]', e.message));
    res.json({ message });
  });

  app.post('/api/chat/:peer/read', (req, res) => {
    markChatRead(meOwner(req), String(req.params.peer));
    res.json({ ok: true });
  });

  // ── 数据备份下载(仅管理员)──
  app.get('/api/backup', (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: '仅管理员可下载' });
    const dest = path.join('/tmp', `msg2todo-backup-${Date.now()}.db`);
    try {
      db.exec(`VACUUM INTO '${dest}'`);
    } catch (e) {
      return res.status(500).json({ error: `备份失败:${e.message}` });
    }
    const date = new Date().toISOString().slice(0, 10);
    res.download(dest, `msg2todo-${date}.db`, () => {
      try { fs.unlinkSync(dest); } catch {}
    });
  });

  // ── 我的设置(App 控制面板数据源)──
  app.get('/api/settings', (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const su = getScheduleUser(owner) || {};
    const wu = getWeatherUser(owner) || {};
    let sTimes = [];
    let wTimes = [];
    try { sTimes = JSON.parse(su.schedule_times || '[]'); } catch {}
    try { wTimes = JSON.parse(wu.times || '[]'); } catch {}
    res.json({
      schedule: {
        notifyTime: su.notify_time || config.schedule.notifyTime,
        times: Array.isArray(sTimes) && sTimes.length ? sTimes : [su.notify_time || config.schedule.notifyTime],
        semesterStart: su.semester_start || config.schedule.semesterStart,
        classRemind: su.class_remind !== 0,
        classRemindMinutes: config.classRemindMinutes,
        sleepTime: su.sleep_time || '',
      },
      weather: {
        city: wu.city || config.weather.city,
        time: wu.notify_time || config.weather.notifyTime,
        times: Array.isArray(wTimes) && wTimes.length ? wTimes : [wu.notify_time || config.weather.notifyTime],
        enabled: wu.enabled !== 0,
      },
      countdown: { time: su.countdown_time || config.countdownNotifyTime },
      background: su.background || '',
      groupWhitelist: getGroupWhitelist(owner),
      push: { kind: su.push_kind || '', hasKey: Boolean(su.push_key) },
      countdowns: listCountdowns(owner).map((c) => ({ ...c, id: Number(c.id) })),
      pomodoro: {
        running: db.prepare("SELECT * FROM pomodoro WHERE owner = ? AND status = 'running'").get(owner) || null,
        stats: pomodoroStats(owner),
      },
    });
  });

  // 背景设置(自定义背景板)
  app.post('/api/background', express.json(), (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const bg = String(req.body?.background ?? '').slice(0, 800 * 1024); // 上限 ~800KB
    upsertScheduleUser(owner, { background: bg });
    res.json({ ok: true });
  });

  // 提醒时段设置:type = schedule(课表,多时段) | weather(天气,多时段) | countdown(倒计时,单时段)
  app.post('/api/reminder/times', express.json(), (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const type = String(req.body?.type || '');
    const times = (Array.isArray(req.body?.times) ? req.body.times : [])
      .map((t) => String(t || '').trim())
      .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
      .sort()
      .slice(0, 3);
    if (type === 'schedule') {
      upsertScheduleUser(owner, { scheduleTimes: JSON.stringify(times) });
    } else if (type === 'weather') {
      upsertWeatherUser(owner, { times: JSON.stringify(times) });
    } else if (type === 'countdown') {
      upsertScheduleUser(owner, { countdownTime: times[0] || '' });
    } else {
      return res.status(400).json({ error: 'type 应为 schedule / weather / countdown' });
    }
    res.json({ ok: true, times });
  });

  // QQ 群白名单:白名单内的群「全部消息」都会处理;其它群仅 @机器人 才处理
  app.post('/api/group-whitelist', express.json(), (req, res) => {
    const owner = req.user.isAdmin ? 'qq:1487138742' : req.user.owner;
    const raw = Array.isArray(req.body?.groups) ? req.body.groups : String(req.body?.groups || '').split(/[\s,]+/);
    const groups = raw.map((g) => String(g).trim().replace(/\D/g, '')).filter(Boolean).slice(0, 50);
    upsertScheduleUser(owner, { groupWhitelist: JSON.stringify(groups) });
    res.json({ ok: true, groups });
  });

  // 总览:看板首页聚合数据(天气/明日课程/倒计时/番茄/待办/自动化时间表)
  app.get('/api/overview', async (req, res) => {
    const me = req.user;
    const nowP = partsOf(new Date());
    const todayStr = partsToStr(nowP);
    const tomP = partsOf(new Date(zonedDate(nowP.y, nowP.mo, nowP.d, 0, 0).getTime() + 86400000));
    const pomo = pomodoroTodayByOwner();

    // 学生只看自己;管理员看全部
    const allUsers = listScheduleUsers().filter((u) => me.isAdmin || u.owner === me.owner);
    const running = db.prepare("SELECT * FROM pomodoro WHERE status = 'running'").all()
      .filter((r) => me.isAdmin || r.owner === me.owner)
      .map((r) => ({ ...r, id: Number(r.id) }));

    const users = allUsers.map((u) => {
      const sem = u.semester_start || config.schedule.semesterStart;
      const items = listScheduleItems(u.owner);
      return {
        ...u,
        itemsCount: items.length,
        tomorrow: buildDayText(items, tomP, sem).visible,
        today: buildDayText(items, nowP, sem).visible,
        pomodoroToday: pomo[u.owner] || 0,
      };
    });

    const countdowns = db.prepare('SELECT c.*, u.name AS user_name FROM countdowns c LEFT JOIN schedule_users u ON u.owner = c.owner ORDER BY c.target').all()
      .filter((c) => me.isAdmin || c.owner === me.owner)
      .map((c) => ({ ...c, id: Number(c.id), daysLeft: daysUntil(c.target, nowP) }));

    const todoOwnerCond = me.isAdmin ? '' : 'AND owner = ?';
    const todoArgs = me.isAdmin ? [] : [me.owner];
    const openDue = db.prepare(`SELECT * FROM todos WHERE status = 'open' AND due_at IS NOT NULL ${todoOwnerCond}`).all(...todoArgs)
      .filter((t) => partsToStr(partsOf(new Date(t.due_at))) <= todayStr)
      .slice(0, 8)
      .map((t) => ({ ...t, id: Number(t.id) }));

    // 天气:学生显示自己设置的城市(或全局),管理员显示全局
    let weather = null;
    let weatherCode = 0;
    let weatherCity = null;
    if (!me.isAdmin) {
      const wu = getWeatherUser(me.owner);
      if (wu && wu.enabled !== 0) weatherCity = wu.city || config.weather.city;
      else if (!wu) weatherCity = config.weather.city; // 未设置过 → 用全局
    } else {
      weatherCity = config.weather.city;
    }
    if (weatherCity) {
      try {
        const data = await getWeather(weatherCity);
        weather = formatWeather(data);
        weatherCode = data.daily?.weather_code?.[0] ?? data.current?.weather_code ?? 0;
      } catch (e) {
        console.warn('[看板] 天气获取失败:', e.message);
      }
    }

    const todoStats = me.isAdmin
      ? stats()
      : (() => {
          const all = db.prepare('SELECT COUNT(*) c, SUM(status=\'open\') o FROM todos WHERE owner = ?').get(me.owner);
          return { open: Number(all.o || 0), done: Number(all.c || 0) - Number(all.o || 0), total: Number(all.c || 0) };
        })();

    res.json({
      me: { isAdmin: me.isAdmin, name: me.name, owner: me.owner },
      stats: todoStats,
      users,
      countdowns,
      runningPomodoro: running,
      dueTodos: openDue,
      weather: weather ? { text: weather, code: weatherCode } : null,
      announcements: listAnnouncementsFor(me.isAdmin ? 'qq:1487138742' : me.owner, 5),
      status: { ...liveStatus, llm: config.llm.enabled, bark: Boolean(config.barkUrl), pushdeer: Boolean(config.pushDeerKey) },
      scheduleTimes: {
        weather: config.weather.city ? config.weather.notifyTime : null,
        countdown: config.countdownNotifyTime,
        schedule: config.schedule.notifyTime,
        weeklyReview: config.weeklyReviewTime,
        classRemind: config.classRemindMinutes,
        sleep: users.map((u) => ({ name: u.name || u.owner, time: u.sleep_time })).filter((x) => x.time),
      },
    });
  });

  // 课表:全部学生及其课程(看板「课表」页);学生只看自己
  app.get('/api/schedule', (req, res) => {
    const pomo = pomodoroTodayByOwner();
    const users = listScheduleUsers()
      .filter((u) => req.user.isAdmin || u.owner === req.user.owner)
      .map((u) => {
        const sem = u.semester_start || config.schedule.semesterStart;
        return {
          ...u,
          items: listScheduleItems(u.owner),
          currentWeek: sem ? weekOf(partsOf(new Date()), sem) : null,
          pomodoroToday: pomo[u.owner] || 0,
        };
      })
      .filter((u) => u.items.length || u.semester_start || u.push_kind);
    res.json({ users, weather: { city: config.weather.city, notifyTime: config.weather.notifyTime } });
  });

  // 清空某个学生的课表(仅管理员)
  app.delete('/api/schedule/:owner', (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: '无权操作' });
    clearSchedule(decodeURIComponent(req.params.owner));
    res.json({ ok: true });
  });

  // 上传课表文件(xlsx)导入:学生导入给自己,管理员可用 ?owner= 指定
  app.post('/api/schedule/import', express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
    const owner = req.user.isAdmin ? String(req.query.owner || '').trim() : req.user.owner;
    if (!/^\w+:.+$/.test(owner)) return res.status(400).json({ error: '缺少 owner 参数(如 ?owner=qq:1487138742)' });
    try {
      const items = await parseScheduleUpload(req.body);
      if (!items.length) return res.status(400).json({ error: '没解析出课程:表格请确认是教务导出的课表;图片请上传清晰的课表截图' });
      upsertScheduleUser(owner, {});
      replaceSchedule(owner, items);
      res.json({ ok: true, count: items.length });
    } catch (e) {
      res.status(400).json({ error: `解析失败:${e.message}` });
    }
  });

  // 删除单条课程(管理员或该课程所属学生)
  app.delete('/api/schedule/item/:id', (req, res) => {
    const item = db.prepare('SELECT * FROM schedule_items WHERE id = ?').get(Number(req.params.id));
    if (!item) return res.status(404).json({ error: '课程不存在' });
    if (!req.user.isAdmin && item.owner !== req.user.owner) return res.status(403).json({ error: '无权操作' });
    if (!deleteScheduleItem(Number(req.params.id))) return res.status(404).json({ error: '课程不存在' });
    res.json({ ok: true });
  });

  // 微信登录二维码(SVG,由服务端渲染)
  app.get('/api/qr.svg', (req, res) => {
    if (!qrSvg) return res.status(404).end();
    res.type('image/svg+xml').send(qrSvg);
  });

  // SSE 实时推送(update/status/qr)
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    sseOwners.set(res, req.user?.isAdmin ? 'qq:1487138742' : req.user?.owner);
    // 补发当前快照
    res.write(`event: status\ndata: ${JSON.stringify({ ...liveStatus, llm: config.llm.enabled, wechatEnabled: config.wechat.enabled })}\n\n`);
    res.write(`event: qr\ndata: ${JSON.stringify({ hasQr: Boolean(qrSvg) })}\n\n`);
    const keepalive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 25000);
    req.on('close', () => {
      clearInterval(keepalive);
      sseClients.delete(res);
      sseOwners.delete(res);
    });
  });

  app.use(express.static(path.join(config.root, 'public')));

  const server = app.listen(config.web.port, config.web.host, () => {
    console.log(`[看板] http://${config.web.host === '0.0.0.0' ? '127.0.0.1' : config.web.host}:${config.web.port}`);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[看板] 端口 ${config.web.port} 被占用,请修改 WEB_PORT 后重启`);
    } else {
      console.error('[看板] 启动失败:', e.message);
    }
  });
  return server;
}
