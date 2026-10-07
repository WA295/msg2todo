import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';
import { config } from './config.js';
import {
  db, listTodos, toggleTodo, deleteTodo, addTodo, stats,
  listScheduleUsers, listScheduleItems, clearSchedule, deleteScheduleItem, replaceSchedule,
  pomodoroTodayByOwner, getScheduleUser, upsertScheduleUser, getUserByToken, setWebToken, randomToken,
} from './db.js';
import { parseLocalInput, partsOf, weekOf, zonedDate, partsToStr, daysUntil } from './time.js';
import { buildDayText } from './schedule.js';
import { getWeather, formatWeather } from './weather.js';
import { parseWorkbook } from './excelImport.js';
import { events, liveStatus } from './events.js';

const sseClients = new Set();
let qrSvg = null;

function broadcast(event, payload) {
  const data = JSON.stringify(payload ?? {});
  for (const res of sseClients) {
    try {
      res.write(`event: ${event}\ndata: ${data}\n\n`);
    } catch {}
  }
}

// 数据变更 → 看板刷新
events.on('change', () => broadcast('update', {}));
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
      owner: req.user.isAdmin ? '' : req.user.owner,
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

    let weather = null;
    if (config.weather.city) {
      try {
        weather = formatWeather(await getWeather(config.weather.city));
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
      weather,
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
  app.post('/api/schedule/import', express.raw({ type: () => true, limit: '10mb' }), (req, res) => {
    const owner = req.user.isAdmin ? String(req.query.owner || '').trim() : req.user.owner;
    if (!/^\w+:.+$/.test(owner)) return res.status(400).json({ error: '缺少 owner 参数(如 ?owner=qq:1487138742)' });
    try {
      const items = parseWorkbook(req.body);
      if (!items.length) return res.status(400).json({ error: '文件里没解析出课程,请确认是教务系统导出的课表' });
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
    // 补发当前快照
    res.write(`event: status\ndata: ${JSON.stringify({ ...liveStatus, llm: config.llm.enabled, wechatEnabled: config.wechat.enabled })}\n\n`);
    res.write(`event: qr\ndata: ${JSON.stringify({ hasQr: Boolean(qrSvg) })}\n\n`);
    const keepalive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 25000);
    req.on('close', () => {
      clearInterval(keepalive);
      sseClients.delete(res);
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
