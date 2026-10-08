import { config } from './config.js';
import { addPackage, listPackages, markPackageDone, deletePackage } from './db.js';
import { extractCourierWithLLM } from './llm.js';

/** 快递公司关键词 */
const COMPANY_KEYS = ['京东', '顺丰', '中通', '圆通', '申通', '韵达', '极兔', '邮政', '百世', '德邦', '菜鸟', '天猫', '淘宝', '拼多多', '丹鸟', '丰网', '圆准达'];

/** 规则识别快递通知:提取取件码/公司/驿站;识别不到返回 null */
function detectCourier(text) {
  let m = text.match(/取件码\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]{2,14})/);
  if (!m) m = text.match(/提货码\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]{2,14})/);
  if (!m) m = text.match(/取件号\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]{2,14})/);
  if (!m) m = text.match(/(?:凭|请使用)\s*([A-Za-z0-9-]{4,12})\s*(?:取件|取货|提货)/);
  if (!m) return null;
  const code = m[1].replace(/[^A-Za-z0-9-]/g, '').slice(0, 30);
  let company = '';
  for (const c of COMPANY_KEYS) {
    if (text.includes(c)) { company = c; break; }
  }
  let location = '';
  const lm = text.match(/(丰巢|菜鸟驿站|兔喜|妈妈驿站|邮政驿站|快递柜|自提柜|代收点|[一-龥]{2,6}驿站)/);
  if (lm) location = lm[1];
  return { code, location, company };
}

/** 快递指令:快递 <取件码> [地点] / 快递(查看)/ 取完 <序号> / 删快递 <序号>
 *  同时自动识别快递到货通知(短信转发/平台通知),自动记录 */
export async function handlePackageCommand(msg) {
  const text = (msg.text || '').trim();
  if (!text) return false;
  const isCourierHint = /取件码|提货码|取件号|驿站|丰巢|快递柜|待取|到货/.test(text);
  if (!/^快递/.test(text) && !/^取完/.test(text) && !/^删快递/.test(text) && !isCourierHint) return false;
  const owner = `${msg.platform}:${msg.chatId}`;
  const reply = async (t) => {
    if (typeof msg.reply === 'function') {
      try { await msg.reply(t); } catch (e) { console.warn('[快递] 回复失败:', e.message); }
    }
  };

  // 查看列表
  if (/^快递$/.test(text)) {
    const list = listPackages(owner);
    if (!list.length) {
      await reply('你还没有待取快递。取件后发「快递 取件码 地点」记录,例如:\n快递 8-1234 丰巢');
      return true;
    }
    const pending = list.filter((p) => p.status === 'pending');
    const done = list.filter((p) => p.status === 'done');
    const lines = pending.map((p, i) => `${i + 1}. ${p.location ? `${p.location} · ` : ''}取件码 ${p.code}`);
    let out = `📦 待取快递 ${pending.length} 件\n${lines.length ? lines.join('\n') : ''}`;
    if (done.length) out += `\n(已取 ${done.length} 件)`;
    out += '\n取完后发「取完 序号」';
    await reply(out);
    return true;
  }

  // 取完
  const doneM = text.match(/^取完\s*(\d+)$/);
  if (doneM) {
    const pending = listPackages(owner).filter((p) => p.status === 'pending');
    const idx = Number(doneM[1]) - 1;
    if (pending[idx]) {
      markPackageDone(pending[idx].id);
      await reply(`✅ 已标记「${pending[idx].code}」为已取`);
    } else {
      await reply('序号不对,发「快递」查看列表');
    }
    return true;
  }

  // 删除
  const delM = text.match(/^删快递\s*(\d+)$/);
  if (delM) {
    const list = listPackages(owner);
    const idx = Number(delM[1]) - 1;
    if (list[idx]) {
      deletePackage(list[idx].id);
      await reply('🗑️ 已删除');
    } else {
      await reply('序号不对,发「快递」查看列表');
    }
    return true;
  }

  // 添加:快递 <取件码> [地点]
  const addM = text.match(/^快递\s+(.+)$/);
  if (addM) {
    const body = addM[1].trim();
    // 形如 "丰巢 8-1234" → 地点 + 码;否则整个当取件码
    const parts = body.split(/\s+/);
    let code;
    let location = '';
    if (parts.length >= 2) {
      location = parts[0];
      code = parts.slice(1).join('');
    } else {
      code = parts[0];
    }
    code = code.slice(0, 30);
    if (!code) {
      await reply('格式:快递 取件码 地点,如「快递 8-1234 丰巢」');
      return true;
    }
    addPackage(owner, code, location);
    await reply(`✅ 已记录快递${location ? `(${location})` : ''}:取件码 ${code}\n发「快递」查看全部,取完发「取完 序号」`);
    return true;
  }

  // 自动识别快递到货通知(如短信/平台通知转发)
  if (isCourierHint) {
    let info = detectCourier(text);
    if (!info && config.llm.enabled) {
      try { info = await extractCourierWithLLM(text); } catch (e) { console.warn('[快递] LLM 解析失败:', e.message); }
    }
    if (info && info.code) {
      addPackage(owner, info.code, info.location, info.company);
      await reply(`✅ 已自动记录快递${info.company ? `(${info.company})` : ''}${info.location ? ` @${info.location}` : ''}\n取件码:${info.code}\n发「快递」查看全部,取完发「取完 1」`);
      return true;
    }
  }

  return false;
}
