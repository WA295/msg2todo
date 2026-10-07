#!/usr/bin/env bash
# msg2todo 一键更新:拉取最新代码 → 安装新依赖(如有)→ 重启服务
# 数据(data/todos.db)与配置(.env)不受影响
set -e
cd "$(dirname "$0")/.."

echo "═══ msg2todo 一键更新 ═══"
echo "[1/4] 拉取最新代码..."
if ! timeout 40 git fetch origin master; then
  echo "❌ 无法连接 GitHub(网络问题),稍后重试或换个网络"
  exit 1
fi
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "✅ 已经是最新版本,无需更新"
  exit 0
fi
git pull origin master

echo "[2/4] 检查依赖..."
if git diff --name-only "$LOCAL" HEAD | grep -q package.json; then
  npm install --no-audit --no-fund
else
  echo "依赖无变化,跳过"
fi

echo "[3/4] 重启服务..."
if systemctl --user is-active msg2todo >/dev/null 2>&1; then
  systemctl --user restart msg2todo
  sleep 3
  systemctl --user is-active msg2todo && echo "✅ 服务已重启"
else
  echo "⚠️ systemd 服务未运行,请手动启动: npm start"
fi

echo "[4/4] 完成。新版本: $(git log -1 --oneline)"
