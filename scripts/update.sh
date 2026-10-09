#!/usr/bin/env bash
# iTodo 一键更新:备份 → 拉取代码 → 装依赖 → 重启 → 健康检查(失败自动回滚)
#
# 修掉旧版的三个真实故障:
#   1. 旧版用 `systemctl --user` 控制系统级单元 → 永远判定"服务未运行",实际从不重启
#   2. 旧版硬编码 master 分支 → 当前检出是 main
#   3. 旧版无回滚、无健康检查
#
# 用法:bash scripts/update.sh
# 环境变量可覆盖:BRANCH(默认 main)、HEALTH_URL、REMOTE_NAME
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"
BRANCH="${BRANCH:-main}"
REMOTE_NAME="${REMOTE_NAME:-origin}"
SERVICE="${SERVICE:-msg2todo}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/api/status}"

echo "═══ iTodo 一键更新($BRANCH)═══"

# ── 读 .env 里的令牌,用于健康检查 ──
TOKEN=""
if [ -f .env ]; then
  TOKEN="$(grep -E '^WEB_AUTH_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
fi

BEFORE="$(git rev-parse HEAD)"
TAG="pre-update-$(date +%Y%m%d-%H%M%S)"

echo "[1/5] 记录回滚点 git tag $TAG"
git tag -f "$TAG" "$BEFORE" >/dev/null

echo "[2/5] 拉取最新代码..."
if ! timeout 60 git fetch "$REMOTE_NAME" "$BRANCH"; then
  echo "❌ 无法连接 GitHub(网络问题),稍后重试或换个网络" >&2
  exit 1
fi
REMOTE="$(git rev-parse "$REMOTE_NAME/$BRANCH")"
if [ "$BEFORE" = "$REMOTE" ]; then
  echo "✅ 已经是最新版本,无需更新"
  exit 0
fi
git pull --ff-only "$REMOTE_NAME" "$BRANCH"

echo "[3/5] 更新数据库快照(更新前保险)"
APP_DIR="$REPO_DIR" bash scripts/backup-db.sh || {
  echo "⚠️ 更新前备份失败 —— 继续更新,但请手工确认备份状态" >&2
}

echo "[4/5] 依赖与重启..."
if git diff --name-only "$BEFORE" HEAD | grep -q '^package.json$'; then
  # 服务器不需要 Electron(桌面版依赖),跳过 postinstall 可省下大量下载/编译
  npm install --no-audit --no-fund --omit=dev --ignore-scripts
else
  echo "  依赖无变化,跳过"
fi

# 系统级单元(部署脚本装的就是系统级)
if systemctl is-active --quiet "$SERVICE"; then
  systemctl restart "$SERVICE"
  sleep 3
else
  echo "⚠️ systemd 单元 $SERVICE 未运行,跳过重启(本地开发请手动 npm start)" >&2
fi

# ── 健康检查 ──
health() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
    -H "x-auth-token: $TOKEN" "$HEALTH_URL" || echo 000)"
  # 401 也说明进程活着并在正确校验令牌;5xx/000 才算不健康
  [ "$code" = "200" ] || [ "$code" = "401" ]
}

echo "[5/5] 健康检查 $HEALTH_URL"
if health; then
  echo "✅ 更新成功:$(git log -1 --oneline)"
  echo "   回滚命令:git reset --hard $TAG && systemctl restart $SERVICE"
else
  echo "❌ 健康检查失败,自动回滚到 $TAG" >&2
  git reset --hard "$TAG"
  if systemctl is-active --quiet "$SERVICE"; then
    systemctl restart "$SERVICE"
  fi
  sleep 3
  health && echo "✅ 已回滚并恢复服务" || echo "❌ 回滚后仍不健康,请立即登录服务器排查" >&2
  exit 1
fi
