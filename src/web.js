import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';
import { config } from './config.js';
import {
  db, listTodos, toggleTodo, deleteTodo, addTodo, stats,
  listScheduleUsers, listScheduleItems, clearSchedule, deleteScheduleItem,
  pomodoroTodayByOwner,
} from './db.js';
import { parseLocalInput, partsOf, weekOf, zonedDate, partsToStr, daysUntil } from './time.js';
import { buildDayText } from './schedule.js';
import { getWeather, formatWeather } from './weather.js';
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

  // 待办列表
  app.get('/api/todos', (req, res) => {
    const status = ['open', 'done'].includes(req.query.status) ? req.query.status : 'all';
    const q = String(req.query.q || '').trim();
    res.json({ todos: listTodos({ status, q }), stats: stats() });
  });

  // 手动添加
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
    });
    res.json(todo);
  });

  // 勾选/取消勾选
  app.post('/api/todos/:id/toggle', (req, res) => {
    const todo = toggleTodo(Number(req.params.id));
    if (!todo) return res.status(404).json({ error: '待办不存在' });
    res.json(todo);
  });

  // 删除
  app.delete('/api/todos/:id', (req, res) => {
    if (!deleteTodo(Number(req.params.id))) return res.status(404).json({ error: '待办不存在' });
    res.json({ ok: true });
  });

  // 运行状态快照
  app.get('/api/status', (req, res) => {
    res.json({ ...liveStatus, llm: config.llm.enabled, wechatEnabled: config.wechat.enabled });
  });

  // 总览:看板首页聚合数据(天气/明日课程/倒计时/番茄/待办/自动化时间表)
  app.get('/api/overview', async (req, res) => {
    const nowP = partsOf(new Date());
    const todayStr = partsToStr(nowP);
    const tomP = partsOf(new Date(zonedDate(nowP.y, nowP.mo, nowP.d, 0, 0).getTime() + 86400000));
    const pomo = pomodoroTodayByOwner();
    const running = db.prepare("SELECT * FROM pomodoro WHERE status = 'running'").all().map((r) => ({ ...r, id: Number(r.id) }));

    const users = listScheduleUsers().map((u) => {
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
      .map((c) => ({ ...c, id: Number(c.id), daysLeft: daysUntil(c.target, nowP) }));

    const openDue = db.prepare("SELECT * FROM todos WHERE status = 'open' AND due_at IS NOT NULL").all()
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

    res.json({
      stats: stats(),
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

  // 课表:全部学生及其课程(看板「课表」页)
  app.get('/api/schedule', (req, res) => {
    const pomo = pomodoroTodayByOwner();
    const users = listScheduleUsers()
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

  // 清空某个学生的课表
  app.delete('/api/schedule/:owner', (req, res) => {
    clearSchedule(decodeURIComponent(req.params.owner));
    res.json({ ok: true });
  });

  // 删除单条课程
  app.delete('/api/schedule/item/:id', (req, res) => {
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
