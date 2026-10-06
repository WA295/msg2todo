import { config } from './config.js';
import { handleIncoming } from './todo.js';
import { events, setStatus } from './events.js';

/** 微信接入(wechaty)。依赖较大,懒加载;失败不影响 QQ 功能 */
export async function startWechat() {
  if (!config.wechat.enabled) {
    console.log('[微信] 未启用 (WECHAT_ENABLED=false)');
    return null;
  }
  setStatus({ wechat: 'connecting' });

  let WechatyBuilder, qrcodeTerminal;
  try {
    const wechatyMod = await import('wechaty');
    WechatyBuilder = wechatyMod.WechatyBuilder;
    const qrMod = await import('qrcode-terminal');
    qrcodeTerminal = qrMod.default?.generate ? qrMod.default : qrMod;
  } catch (e) {
    console.error('[微信] 加载 wechaty 失败,微信功能不可用:', e.message);
    console.error('[微信] 请确认依赖安装完整 (npm install)。QQ 功能不受影响。');
    setStatus({ wechat: 'off' });
    return null;
  }

  let puppet = config.wechat.puppet;
  if (puppet === 'padlocal') puppet = 'wechaty-puppet-wechat'; // padlocal 付费 iPad 协议
  const puppetOptions = {};
  if (config.wechat.token) puppetOptions.token = config.wechat.token;

  let bot;
  try {
    bot = WechatyBuilder.build({ name: 'msg2todo', puppet, puppetOptions });
  } catch (e) {
    console.error('[微信] 初始化失败:', e.message);
    setStatus({ wechat: 'off' });
    return null;
  }

  bot.on('scan', (qrcode, status) => {
    if (status === 2) {
      console.log('\n[微信] 请用手机微信扫码登录(二维码):\n');
      qrcodeTerminal.generate(qrcode, { small: true });
    }
    setStatus({ wechat: 'scanning' });
    events.emit('wechat-qr', { text: qrcode, status });
  });
  bot.on('login', (user) => {
    console.log(`[微信] 已登录: ${user.name()}`);
    setStatus({ wechat: 'on', wechatName: user.name() });
    events.emit('wechat-qr', null); // 清除二维码
  });
  bot.on('logout', (user) => {
    console.log(`[微信] 已退出: ${user.name()}`);
    setStatus({ wechat: 'off', wechatName: '' });
  });
  bot.on('error', (e) => console.error('[微信] 错误:', e.message));

  bot.on('message', async (message) => {
    try {
      if (message.self()) return;
      if (message.type() !== bot.Message.Type.Text) return;

      const room = message.room();
      const isGroup = Boolean(room);
      const text = (message.text() || '').trim();
      if (!text) return;

      let mentioned = true;
      if (isGroup) {
        try {
          mentioned = await message.mentionSelf();
        } catch {
          mentioned = false;
        }
        if (!config.wechat.processAllGroup && !mentioned) return;
      }

      const talker = message.talker();
      const sender = talker.name();

      await handleIncoming({
        platform: 'wechat',
        chatId: room ? room.id : talker.id,
        chatName: room ? (await room.topic().catch(() => '')) : sender,
        sender,
        text,
        isGroup,
        mentioned,
        reply: (t) => message.say(t).catch((e) => console.warn('[微信] 回复失败:', e.message)),
      });
    } catch (e) {
      console.error('[微信] 处理消息出错:', e.message);
    }
  });

  try {
    await bot.start();
    console.log(`[微信] wechaty 已启动 (puppet: ${puppet})`);
  } catch (e) {
    console.error('[微信] 启动失败:', e.message);
    setStatus({ wechat: 'off' });
    return null;
  }
  return bot;
}
