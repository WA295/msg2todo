/**
 * 模拟一个 OneBot v11 客户端,用于在没有真实 QQ 环境时测试 msg2todo。
 * 用法: node scripts/simulate-onebot.js [ws地址]
 * 环境变量 ONE_BOT_ACCESS_TOKEN 与服务端一致(若服务端配置了 token)
 */
import WebSocket from 'ws';

const url = process.argv[2] || 'ws://127.0.0.1:3001';
const token = process.env.ONE_BOT_ACCESS_TOKEN || '';

const ws = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});

const SELF_ID = 10001;

ws.on('open', () => {
  console.log(`已连接 ${url}`);
  // 上报生命周期事件(服务端会向我们要登录信息)
  ws.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'enable', self_id: SELF_ID, time: Math.floor(Date.now() / 1000) }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('收到服务端动作:', JSON.stringify(msg));

  if (msg.action === 'get_login_info') {
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: msg.echo, data: { user_id: SELF_ID, nickname: '测试机器人' } }));
    // 登录信息回复后,发两条测试消息
    setTimeout(() => {
      // 1. 私聊:自然语言待办
      ws.send(JSON.stringify({
        post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: 1001, time: Math.floor(Date.now() / 1000),
        user_id: 20002, sender: { user_id: 20002, nickname: '小明' },
        message: [{ type: 'text', data: { text: '明天下午3点提醒我交高数作业' } }],
      }));
    }, 300);
    setTimeout(() => {
      // 2. 群聊:@机器人的待办
      ws.send(JSON.stringify({
        post_type: 'message', message_type: 'group', sub_type: 'normal', message_id: 1002, time: Math.floor(Date.now() / 1000),
        group_id: 30001, user_id: 20003, sender: { user_id: 20003, nickname: '小红', card: '小红' },
        message: [
          { type: 'at', data: { qq: String(SELF_ID) } },
          { type: 'text', data: { text: ' 周五下班前把实验报告发我,很重要' } },
        ],
      }));
    }, 600);
    setTimeout(() => {
      // 3. 群聊:未 @ 机器人(应被忽略)
      ws.send(JSON.stringify({
        post_type: 'message', message_type: 'group', sub_type: 'normal', message_id: 1003, time: Math.floor(Date.now() / 1000),
        group_id: 30001, user_id: 20004, sender: { user_id: 20004, nickname: '小刚' },
        message: [{ type: 'text', data: { text: '今天天气不错' } }],
      }));
    }, 900);
    setTimeout(() => {
      // 4. 私聊:闲聊(应被判定为非待办)
      ws.send(JSON.stringify({
        post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: 1004, time: Math.floor(Date.now() / 1000),
        user_id: 20002, sender: { user_id: 20002, nickname: '小明' },
        message: [{ type: 'text', data: { text: '在吗?问你个事' } }],
      }));
    }, 1200);
    setTimeout(() => {
      // 5. 私聊:设置课表(含单双周/周次)
      ws.send(JSON.stringify({
        post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: 1005, time: Math.floor(Date.now() / 1000),
        user_id: 20002, sender: { user_id: 20002, nickname: '小明' },
        message: [{ type: 'text', data: { text: '课表\n周一 08:00-09:40 高等数学 @一教101\n周一 10:00-11:40 大学英语 1-16周\n周二 14:00-15:40 物理实验 双周\n周五 19:00-20:40 形势与政策 5-8周单周' } }],
      }));
    }, 1500);
    setTimeout(() => {
      // 6. 私聊:查询明天的课
      ws.send(JSON.stringify({
        post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: 1006, time: Math.floor(Date.now() / 1000),
        user_id: 20002, sender: { user_id: 20002, nickname: '小明' },
        message: [{ type: 'text', data: { text: '明天什么课' } }],
      }));
    }, 1800);
    setTimeout(() => {
      // 7. 私聊:番茄钟
      ws.send(JSON.stringify({
        post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: 1007, time: Math.floor(Date.now() / 1000),
        user_id: 20002, sender: { user_id: 20002, nickname: '小明' },
        message: [{ type: 'text', data: { text: '番茄 25 5 2' } }],
      }));
    }, 2100);
    setTimeout(() => {
      // 8. 私聊:番茄统计
      ws.send(JSON.stringify({
        post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: 1008, time: Math.floor(Date.now() / 1000),
        user_id: 20002, sender: { user_id: 20002, nickname: '小明' },
        message: [{ type: 'text', data: { text: '番茄统计' } }],
      }));
    }, 2400);
    setTimeout(() => { console.log('测试结束,退出'); process.exit(0); }, 4500);
  }
});

ws.on('error', (e) => { console.error('连接失败:', e.message); process.exit(1); });
