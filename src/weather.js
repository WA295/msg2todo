import { config } from './config.js';
import { getWeatherUser, upsertWeatherUser, setWeatherReminded, listScheduleUsers } from './db.js';
import { partsOf } from './time.js';
import { sendBark, sendPushDeer } from './notify.js';
import { sendQQPrivate } from './onebot.js';
import { getScheduleUser } from './db.js';

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** WMO 天气代码 → [中文, 图标] */
const WMO = {
  0: ['晴', '☀️'], 1: ['大致晴', '🌤'], 2: ['多云', '⛅'], 3: ['阴', '☁️'],
  45: ['雾', '🌫'], 48: ['雾凇', '🌫'],
  51: ['毛毛雨', '🌦'], 53: ['毛毛雨', '🌦'], 55: ['毛毛雨', '🌦'],
  56: ['冻毛毛雨', '🌧'], 57: ['冻毛毛雨', '🌧'],
  61: ['小雨', '🌧'], 63: ['中雨', '🌧'], 65: ['大雨', '🌧'],
  66: ['冻雨', '🌧'], 67: ['冻雨', '🌧'],
  71: ['小雪', '🌨'], 73: ['中雪', '🌨'], 75: ['大雪', '❄️'], 77: ['雪粒', '❄️'],
  80: ['阵雨', '🌧'], 81: ['阵雨', '🌧'], 82: ['强阵雨', '⛈'],
  85: ['阵雪', '🌨'], 86: ['阵雪', '❄️'],
  95: ['雷雨', '⛈'], 96: ['雷雨冰雹', '⛈'], 99: ['雷雨冰雹', '⛈'],
};
const WD_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function wmo(code) {
  return WMO[code] || ['未知', '🌡'];
}

/** km/h 风力 → 蒲福风级(约) */
function windLevel(kmh) {
  const kmhToLevel = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  let lv = 0;
  for (const v of kmhToLevel) if (kmh >= v) lv++;
  return lv;
}

const cache = new Map(); // city -> { exp, data }

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 获取城市天气(带 10 分钟缓存),失败抛错 */
export async function getWeather(city) {
  const hit = cache.get(city);
  if (hit && Date.now() < hit.exp) return hit.data;
  const g = await fetchJson(`${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`, 8000);
  const loc = g?.results?.[0];
  if (!loc) throw new Error(`未找到城市「${city}」`);
  const tz = loc.timezone || 'Asia/Shanghai';
  const f = await fetchJson(
    `${FORECAST_URL}?latitude=${loc.latitude}&longitude=${loc.longitude}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max` +
    `&timezone=${encodeURIComponent(tz)}&forecast_days=2`,
    8000
  );
  const data = { city: loc.name, admin1: loc.admin1 || '', current: f.current, daily: f.daily };
  cache.set(city, { exp: Date.now() + 10 * 60 * 1000, data });
  return data;
}

/** 一天摘要:如 "☀️ 晴 8~18°C · 降水20% · 风3级" */
function dayLine(d, i) {
  const [name, icon] = wmo(d.weather_code[i]);
  const lo = Math.round(d.temperature_2m_min[i]);
  const hi = Math.round(d.temperature_2m_max[i]);
  const rain = d.precipitation_probability_max?.[i] ?? 0;
  const wind = d.wind_speed_10m_max?.[i] ?? 0;
  return `${icon} ${name} ${lo}~${hi}°C · 降水${rain}% · 风${windLevel(wind)}级`;
}

/** 生活提示 */
function tips(d) {
  const t = [];
  if (d.precipitation_probability_max?.[0] >= 50) t.push('今天有雨,出门带伞 ☔');
  if (d.precipitation_probability_max?.[1] >= 50) t.push('明天有雨,记得带伞 ☔');
  if (d.temperature_2m_max[0] <= 10) t.push('天气冷,注意保暖 🧥');
  if (d.temperature_2m_max[0] >= 30) t.push('天气热,注意防晒补水 🧊');
  if (d.temperature_2m_max[0] - d.temperature_2m_min[0] >= 8) t.push('昼夜温差大,注意增减衣物');
  return t;
}

/** 组合完整天气消息(今日+明日+提示) */
export function formatWeather(data, { dateParts } = {}) {
  const p = dateParts || partsOf(new Date());
  const head = `🌤 ${data.city}${data.admin1 ? `(${data.admin1})` : ''}天气 · ${p.mo}月${p.d}日 ${WD_NAMES[p.wd]}`;
  const cur = data.current;
  const nowLine = cur?.temperature_2m != null
    ? `此刻 ${Math.round(cur.temperature_2m)}°C 体感 ${Math.round(cur.apparent_temperature ?? cur.temperature_2m)}°C · ${wmo(cur.weather_code)[1]}${wmo(cur.weather_code)[0]}`
    : null;
  const lines = [head];
  if (nowLine) lines.push(nowLine);
  lines.push(`今日:${dayLine(data.daily, 0)}`);
  lines.push(`明日:${dayLine(data.daily, 1)}`);
  const tp = tips(data.daily);
  if (tp.length) lines.push('💡 ' + tp.join(';'));
  return lines.join('\n');
}

/** 通知某人(QQ 私聊 + 已绑定的手机推送) */
function notify(owner, text) {
  if (owner.startsWith('qq:')) sendQQPrivate(owner.slice(3), text);
  const u = getScheduleUser(owner);
  if (u?.push_kind === 'bark') sendBark('🌤 天气', text, u.push_key);
  else if (u?.push_kind === 'pushdeer') sendPushDeer('🌤 天气', text, u.push_key);
}

/* ================= 每日推送 ================= */

let timer = null;

export function startWeatherReminder() {
  if (!config.weather.city) {
    console.log('[天气] 未配置 WEATHER_CITY,每日天气推送未启用');
    return;
  }
  console.log(`[天气] 每天 ${config.weather.notifyTime} 推送天气(默认城市:${config.weather.city})`);
  timer = setInterval(() => { check().catch((e) => console.warn('[天气] 检查出错:', e.message)); }, 60000);
  check().catch((e) => console.warn('[天气] 首次检查出错:', e.message));
}

export function stopWeatherReminder() {
  if (timer) clearInterval(timer);
}

async function check() {
  const nowP = partsOf(new Date());
  const curMin = nowP.h * 60 + nowP.mi;
  const today = `${nowP.y}-${String(nowP.mo).padStart(2, '0')}-${String(nowP.d).padStart(2, '0')}`;

  // 所有已登记学生(有课表/设置过)默认收全局城市天气;个人设置优先
  for (const u of listScheduleUsers()) {
    const w = getWeatherUser(u.owner);
    if (w && !w.enabled) continue;
    const city = w?.city || config.weather.city;
    if (!city) continue;
    const [h, m] = (w?.notify_time || config.weather.notifyTime).split(':').map(Number);
    if (curMin < h * 60 + m) continue;
    if (w?.last_weather_remind === today) continue;
    try {
      const data = await getWeather(city);
      const text = formatWeather(data, { dateParts: nowP });
      notify(u.owner, text);
      setWeatherReminded(u.owner, today);
      console.log(`[天气] 已推送 ${city} 天气给「${u.owner}」`);
    } catch (e) {
      console.warn(`[天气] 获取 ${city} 失败:`, e.message);
    }
  }
}

/* ================= 指令 ================= */

/** 判断是否为天气指令,是则处理并返回 true */
export async function handleWeatherCommand(msg) {
  const text = (msg.text || '').trim();
  if (!text) return false;
  if (!/^(天气|今天天气|明天天气|设置天气|天气城市|天气提醒|关闭天气|开启天气)/.test(text)) return false;
  const owner = `${msg.platform}:${msg.chatId}`;
  const reply = async (t) => {
    if (typeof msg.reply === 'function') {
      try { await msg.reply(t); } catch (e) { console.warn('[天气] 回复失败:', e.message); }
    }
  };

  // 设置城市
  const cityM = text.match(/^(?:设置天气|天气城市)\s*[:：]?\s*(.+)$/);
  if (cityM) {
    const city = cityM[1].trim().slice(0, 20);
    try {
      const data = await getWeather(city);
      upsertWeatherUser(owner, { city: data.city, enabled: 1 });
      await reply(`✅ 天气城市已设为「${data.city}」,每天 ${config.weather.notifyTime} 推送天气\n\n${formatWeather(data)}`);
    } catch (e) {
      await reply(`❌ ${e.message}(请确认城市名,如「设置天气 沈阳」)`);
    }
    return true;
  }

  // 推送时间
  const timeM = text.match(/^(?:天气提醒)\s*[:：]?\s*(\d{1,2})[:：](\d{2})$/);
  if (timeM) {
    const h = Number(timeM[1]);
    const mi = Number(timeM[2]);
    if (h > 23 || mi > 59) { await reply('时间格式不对,请用:天气提醒 07:30'); return true; }
    upsertWeatherUser(owner, { notifyTime: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`, enabled: 1 });
    await reply(`✅ 每天 ${timeM[1]}:${timeM[2]} 推送天气`);
    return true;
  }

  // 关闭/开启
  if (/^关闭天气/.test(text)) {
    upsertWeatherUser(owner, { enabled: 0 });
    await reply('🔕 已关闭天气推送;想重新开启发「开启天气」');
    return true;
  }
  if (/^开启天气/.test(text)) {
    upsertWeatherUser(owner, { enabled: 1 });
    await reply('🔔 已开启天气推送');
    return true;
  }

  // 查询:明天 / 今天 / 当前
  const tomorrow = /^明天天气/.test(text);
  const u = getWeatherUser(owner);
  const city = u?.city || config.weather.city;
  if (!city) {
    await reply('还没有设置城市。发「设置天气 沈阳」即可(每天还会定时推送)');
    return true;
  }
  try {
    const data = await getWeather(city);
    if (tomorrow) {
      const p = partsOf(new Date(Date.now() + 86400000));
      const line = dayLine(data.daily, 1);
      const tp = tips(data.daily).filter((t) => t.startsWith('明天'));
      await reply(`🌤 明天(${p.mo}月${p.d}日 ${WD_NAMES[p.wd]})${data.city}:\n${line}${tp.length ? '\n💡 ' + tp.join(';') : ''}`);
    } else {
      await reply(formatWeather(data));
    }
  } catch (e) {
    await reply(`❌ 天气获取失败:${e.message}`);
  }
  return true;
}
