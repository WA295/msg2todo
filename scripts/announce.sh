#!/usr/bin/env bash
# 一键发布 iTodo 公告(默认发到云端)
# 用法: bash scripts/announce.sh "标题" "内容"
# 可用环境变量覆盖: SERVER(默认 http://182.92.163.6:8080)、ADMIN_TOKEN(默认 wq1007cloud)
set -e
SERVER="${SERVER:-http://182.92.163.6:8080}"
TOKEN="${ADMIN_TOKEN:-wq1007cloud}"
TITLE="$1"
CONTENT="$2"
if [ -z "$TITLE" ] || [ -z "$CONTENT" ]; then
  echo "用法: bash scripts/announce.sh \"标题\" \"内容\""
  exit 1
fi
node -e '
const http = require("http");
const [server, token, title, content] = process.argv.slice(1);
const u = new URL(server);
const body = JSON.stringify({ title, content });
const req = http.request({ host: u.hostname, port: u.port || 80, path: "/api/announcements", method: "POST",
  headers: { "Content-Type": "application/json", "x-auth-token": token, "Content-Length": Buffer.byteLength(body) } },
  (r) => { let s = ""; r.on("data", (d) => (s += d)); r.on("end", () => { console.log("返回", r.statusCode, s.trim()); process.exit(r.statusCode === 200 ? 0 : 1); }); });
req.on("error", (e) => { console.error("失败:", e.message); process.exit(1); });
req.write(body); req.end();
' "$SERVER" "$TOKEN" "$TITLE" "$CONTENT"
echo "✅ 公告已发布"
