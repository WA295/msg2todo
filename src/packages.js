import { addPackage, listPackages, markPackageDone, deletePackage } from './db.js';

/** 快递指令:快递 <取件码> [地点] / 快递(查看)/ 取完 <序号> / 删快递 <序号> */
export async function handlePackageCommand(msg) {
  const text = (msg.text || '').trim();
  if (!text) return false;
  if (!/^快递/.test(text) && !/^取完/.test(text) && !/^删快递/.test(text)) return false;
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

  return false;
}
