#!/usr/bin/env bash
# 一键发布 iTodo 公告
# 用法:SERVER=https://<你的域名> ADMIN_TOKEN=<管理员令牌> bash scripts/announce.sh "标题" "内容"
#
# ⚠️ 安全说明:此脚本此前把生产 IP 与管理员令牌硬编码为默认值,已随公开仓库泄露。
#    现已移除默认值 —— ADMIN_TOKEN 必须显式提供(或从 .env 读取),不再有兜底密钥。
set -euo pipefail

# 优先读仓库根的 .env(不进 Git),避免令牌出现在命令行/历史里
if [ -z "${ADMIN_TOKEN:-}" ] && [ -f "$(dirname "$0")/../.env" ]; then
  ADMIN_TOKEN="$(grep -E '^WEB_AUTH_TOKEN=' "$(dirname "$0")/../.env" | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
fi

SERVER="${SERVER:-http://127.0.0.1:8080}"
TOKEN="${ADMIN_TOKEN:-}"

TITLE="${1:-}"
CONTENT="${2:-}"

if [ -z "$TITLE" ] || [ -z "$CONTENT" ]; then
  echo "用法:ADMIN_TOKEN=<令牌> bash scripts/announce.sh \"标题\" \"内容\""
  exit 1
fi
if [ -z "$TOKEN" ]; then
  echo "❌ 未提供管理员令牌。请设置 ADMIN_TOKEN 环境变量,或在仓库根 .env 里配置 WEB_AUTH_TOKEN。" >&2
  exit 1
fi

# 用 node 的 fetch,http/https 都能走(旧版只支持 http,换成 https 域名会失败)
SERVER="$SERVER" TOKEN="$TOKEN" TITLE="$TITLE" CONTENT="$CONTENT" node -e '
const { SERVER, TOKEN, TITLE, CONTENT } = process.env;
const url = new URL("/api/announcements", SERVER).toString();
const body = JSON.stringify({ title: TITLE, content: CONTENT });
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-auth-token": TOKEN },
  body,
});
const text = await res.text();
console.log("返回", res.status, text.trim());
process.exit(res.ok ? 0 : 1);
'
echo "✅ 公告已发布"
