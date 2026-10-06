import { config } from './config.js';
import { startAll, stopAll } from './server.js';

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  📝 msg2todo  微信/QQ 消息 → 待办');
console.log(`  时区: ${config.tz}`);
console.log(`  LLM: ${config.llm.enabled ? `${config.llm.model} @ ${config.llm.baseUrl}` : '未配置(使用本地规则提取)'}`);
console.log(`  数据: ${config.dbPath}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const handles = startAll();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\n正在退出...');
  await stopAll(handles);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
