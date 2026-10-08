import { db, getScheduleUser, startPomodoro, getRunningPomodoro, stopPomodoro, setPomodoroPhase, finishPomodoro, logPomodoro, pomodoroStats } from './db.js';
import { sendBark, sendPushDeer } from './notify.js';
import { sendQQPrivate } from './onebot.js';
import { sendWebPush } from './push.js';

const DEF_FOCUS = 25;
const DEF_REST = 5;
const DEF_ROUNDS = 1;

let timer = null;

/** 番茄钟检查器(每 5 秒检查一次阶段切换) */
export function startPomodoroChecker() {
  console.log('[番茄] 番茄钟已启用(每 5 秒检查)');
  timer = setInterval(check, 5000);
}

export function stopPomodoroChecker() {
  if (timer) clearInterval(timer);
}

/** 通知某人:QQ 私聊 + Web Push + 已绑定的手机推送 */
function notify(owner, text) {
  sendWebPush(owner, '🍅 番茄钟', text);
  if (owner.startsWith('qq:')) sendQQPrivate(owner.slice(3), text);
  const u = getScheduleUser(owner);
  if (u?.push_kind === 'bark') sendBark('🍅 番茄钟', text, u.push_key);
  else if (u?.push_kind === 'pushdeer') sendPushDeer('🍅 番茄钟', text, u.push_key);
}

function check() {
  const now = Date.now();
  const rows = db.prepare("SELECT * FROM pomodoro WHERE status = 'running'").all();
  for (const p of rows) {
    const durMin = p.phase === 'focus' ? p.focus_min : p.rest_min;
    const endAt = new Date(p.phase_started).getTime() + durMin * 60000;
    if (now < endAt) continue;

    if (p.phase === 'focus') {
      // 一轮专注完成
      logPomodoro({ owner: p.owner, focusMin: p.focus_min });
      if (p.round < p.rounds) {
        setPomodoroPhase(p.id, { phase: 'rest', round: p.round, phaseStarted: new Date().toISOString() });
        notify(p.owner, `第 ${p.round} 轮专注完成!🍅\n休息 ${p.rest_min} 分钟吧,休息结束我叫你`);
        console.log(`[番茄] ${p.owner} 第 ${p.round}/${p.rounds} 轮专注完成,进入休息`);
      } else {
        finishPomodoro(p.id);
        const s = pomodoroStats(p.owner);
        notify(p.owner, `🎉 ${p.rounds} 轮番茄钟全部完成!\n今天已完成 ${s.today} 个番茄,累计专注 ${s.focusMinutes} 分钟`);
        console.log(`[番茄] ${p.owner} 全部完成,今日 ${s.today} 个`);
      }
    } else {
      // 休息结束,开始下一轮
      const next = p.round + 1;
      setPomodoroPhase(p.id, { phase: 'focus', round: next, phaseStarted: new Date().toISOString() });
      notify(p.owner, `💪 休息结束,开始第 ${next}/${p.rounds} 轮专注!`);
      console.log(`[番茄] ${p.owner} 开始第 ${next}/${p.rounds} 轮`);
    }
  }
}

/** 判断是否为番茄钟指令,是则处理并返回 true */
export async function handlePomodoroCommand(msg) {
  const text = (msg.text || '').trim();
  if (!text) return false;
  if (!/^番茄/.test(text) && !/^(开始|结束|停止|取消)番茄/.test(text)) return false;
  const owner = `${msg.platform}:${msg.chatId}`;
  const reply = async (t) => {
    if (typeof msg.reply === 'function') {
      try { await msg.reply(t); } catch (e) { console.warn('[番茄] 回复失败:', e.message); }
    }
  };

  // 统计
  if (/^(番茄统计|番茄状态)$/.test(text)) {
    const s = pomodoroStats(owner);
    const running = getRunningPomodoro(owner);
    let line = `🍅 番茄统计\n今日:${s.today} 个 · 累计:${s.total} 个 · 累计专注:${Math.round(s.focusMinutes / 60 * 10) / 10} 小时`;
    if (running) {
      const rest = running.phase === 'rest' ? '休息中' : '专注中';
      line += `\n当前:第 ${running.round}/${running.rounds} 轮 ${rest}(${running.phase === 'focus' ? running.focus_min : running.rest_min} 分钟)`;
    } else {
      line += '\n当前没有进行中的番茄钟';
    }
    await reply(line);
    return true;
  }

  // 取消
  if (/^(结束番茄|停止番茄|取消番茄)/.test(text)) {
    if (stopPomodoro(owner)) await reply('⏹️ 已取消番茄钟,继续加油~');
    else await reply('你当前没有进行中的番茄钟');
    return true;
  }

  // 开始:番茄 [专注分钟] [休息分钟] [轮数]
  if (/^(开始番茄|番茄)/.test(text)) {
    const nums = [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));
    const focus = nums[0] || DEF_FOCUS;
    const rest = nums[1] || DEF_REST;
    const rounds = nums[2] || DEF_ROUNDS;
    if (focus < 1 || focus > 180) { await reply('专注时长要在 1~180 分钟之间哦'); return true; }
    if (rest < 1 || rest > 60) { await reply('休息时长要在 1~60 分钟之间哦'); return true; }
    if (rounds < 1 || rounds > 12) { await reply('轮数要在 1~12 之间哦'); return true; }
    startPomodoro({ owner, focusMin: focus, restMin: rest, rounds });
    await reply(`🍅 番茄钟开始:${rounds} 轮 × (专注 ${focus} 分钟 + 休息 ${rest} 分钟)\n第 1 轮专注中,到点我会提醒你`);
    return true;
  }

  return false;
}
