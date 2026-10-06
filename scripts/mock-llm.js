/**
 * 本地模拟一个 OpenAI 兼容的 LLM 接口,用于测试 LLM 提取链路。
 * 用法: node scripts/mock-llm.js (默认端口 9099)
 * 然后以 LLM_BASE_URL=http://127.0.0.1:9099 LLM_API_KEY=x 启动 msg2todo
 */
import http from 'node:http';

const port = Number(process.argv[2] || 9099);

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let userText = '';
      try {
        const payload = JSON.parse(body);
        userText = payload.messages?.find((m) => m.role === 'user')?.content || '';
      } catch {}
      console.log('[mock-llm] 收到请求,消息内容片段:', userText.slice(0, 60));

      const reply = {
        isTodo: true,
        title: '(LLM) ' + (userText.match(/「(.+?)」/)?.[1]?.slice(0, 20) || '模拟提取的待办'),
        dueAt: '2026-10-07T15:00:00+08:00',
        priority: 'high',
        notes: '来自 mock-llm 的测试数据',
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
    });
  })
  .listen(port, () => console.log(`[mock-llm] 监听 http://127.0.0.1:${port}/chat/completions`));
