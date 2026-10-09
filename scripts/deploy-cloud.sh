#!/usr/bin/env bash
# ═══ iTodo 云服务器一键部署(幂等,可重复执行)═══
#
# 在全新的 Ubuntu 22.04 / 24.04 上以 root 运行:
#   TOKEN=<管理员令牌> DOMAIN=<你的域名> bash scripts/deploy-cloud.sh
#
# 可选环境变量:
#   TOKEN=<令牌>         管理员令牌(必填,不再有默认值)
#   DOMAIN=<域名>        HTTPS 域名(不填则只装 HTTP,证书留待后续)
#   QQ_NUMBER=<QQ号>     公共机器人 QQ 号(填写才装 NapCat)
#   MIRROR=1             国内网络:走 npmmirror / ghfast 镜像
#   NODE_VERSION=22.14.0 Node 版本
#   REPO=<git url>       代码来源(默认本项目仓库)
#
# 设计原则(相对旧版):
#   1. 每一步都幂等,可重复跑:不会重复下载/重复覆盖配置
#   2. Node 下载校验官方 SHA-256(旧版不校验)
#   3. 主服务以低权限用户 itodo 运行(旧版 root)
#   4. systemd / Caddy 配置从仓库 deploy/ 目录安装,不再 heredoc 硬编码
#   5. 服务器 npm install 跳过 Electron 相关 postinstall(旧版会在 2C2G 上装 Electron)
#   6. 备份 timer 一并装上(旧版只在文档里提过,实际不存在)
set -euo pipefail

TOKEN="${TOKEN:-}"
DOMAIN="${DOMAIN:-}"
QQ_NUMBER="${QQ_NUMBER:-}"
MIRROR="${MIRROR:-0}"
NODE_VERSION="${NODE_VERSION:-22.14.0}"
APP_DIR="${APP_DIR:-/opt/msg2todo}"
REPO="${REPO:-https://github.com/Miraculy/msg2todo.git}"
BRANCH="${BRANCH:-main}"
SERVICE_USER="${SERVICE_USER:-itodo}"

log() { echo -e "\n\033[1;34m▶ $*\033[0m"; }
die() { echo -e "\n\033[1;31m✗ $*\033[0m" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请以 root 运行(部署需要写 systemd 单元)"
[ -n "$TOKEN" ] || die "必须提供管理员令牌:TOKEN=<你的令牌> bash scripts/deploy-cloud.sh
  生成方式:openssl rand -hex 24
  (旧版有硬编码默认令牌并已随公开仓库泄露,因此这里不再提供默认值)"

echo "═══ iTodo 云部署开始 ═══"
echo "  目录: $APP_DIR"
echo "  仓库: $REPO (分支 $BRANCH)"
echo "  域名: ${DOMAIN:-<未提供,仅 HTTP>}"
echo "  机器人 QQ: ${QQ_NUMBER:-<不安装 NapCat>}"

# ─────────────────────────────────────────────────────────────
log "[1/8] 基础依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git unzip ca-certificates xz-utils jq >/dev/null

# ─────────────────────────────────────────────────────────────
log "[2/8] 安装 Node.js v$NODE_VERSION(带 SHA-256 校验)"
if command -v node >/dev/null 2>&1 && [ "$(node -v)" = "v$NODE_VERSION" ]; then
  echo "  已安装 $(node -v),跳过"
else
  ARCH="linux-x64"
  TARBALL="node-v$NODE_VERSION-$ARCH.tar.xz"
  if [ "$MIRROR" = "1" ]; then
    BASE="https://npmmirror.com/mirrors/node/v$NODE_VERSION"
  else
    BASE="https://nodejs.org/dist/v$NODE_VERSION"
  fi
  curl -fsSL "$BASE/$TARBALL" -o "/tmp/$TARBALL" || die "下载 Node 失败"
  curl -fsSL "$BASE/SHASUMS256.txt" -o /tmp/SHASUMS256.txt || die "下载校验和失败"
  EXPECT="$(grep " $TARBALL\$" /tmp/SHASUMS256.txt | awk '{print $1}')"
  [ -n "$EXPECT" ] || die "校验和文件里找不到 $TARBALL"
  ACTUAL="$(sha256sum "/tmp/$TARBALL" | awk '{print $1}')"
  if [ "$EXPECT" != "$ACTUAL" ]; then
    die "Node 安装包校验失败!
  期望: $EXPECT
  实际: $ACTUAL
  可能被中间人篡改或镜像内容不符,已中止。"
  fi
  echo "  SHA-256 校验通过"
  tar -xJf "/tmp/$TARBALL" -C /usr/local --strip-components=1
  rm -f "/tmp/$TARBALL" /tmp/SHASUMS256.txt
  echo "  已安装 $(node -v) / npm $(npm -v)"
fi

# ─────────────────────────────────────────────────────────────
log "[3/8] 部署用户与目录"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" --create-home "$SERVICE_USER"
  echo "  已创建系统用户 $SERVICE_USER"
else
  echo "  用户 $SERVICE_USER 已存在"
fi

# ─────────────────────────────────────────────────────────────
log "[4/8] 拉取代码"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
  echo "  已更新到 $(git -C "$APP_DIR" log -1 --oneline)"
else
  # 目录可能已被 useradd -m 创建,git clone 允许非空但空目录更稳
  rmdir "$APP_DIR" 2>/dev/null || true
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

# ─────────────────────────────────────────────────────────────
log "[5/8] 安装依赖(跳过 Electron 相关 postinstall)"
cd "$APP_DIR"
# --ignore-scripts:避免 package.json 的 postinstall 拉 Electron + 重建原生依赖
# 本项目运行时只依赖 express/ws/web-push/qrcode/xlsx,不需要 Electron
npm install --no-audit --no-fund --omit=dev --ignore-scripts

# ─────────────────────────────────────────────────────────────
log "[6/8] 生成生产 .env"
if [ -f "$APP_DIR/.env" ]; then
  echo "  .env 已存在,只确保令牌是最新值(不会覆盖其他配置)"
  if grep -q '^WEB_AUTH_TOKEN=' "$APP_DIR/.env"; then
    sed -i "s|^WEB_AUTH_TOKEN=.*|WEB_AUTH_TOKEN=$TOKEN|" "$APP_DIR/.env"
  else
    echo "WEB_AUTH_TOKEN=$TOKEN" >> "$APP_DIR/.env"
  fi
else
  cp "$APP_DIR/deploy/env/production.env.example" "$APP_DIR/.env"
  sed -i "s|^WEB_AUTH_TOKEN=.*|WEB_AUTH_TOKEN=$TOKEN|" "$APP_DIR/.env"
  # 生成 OneBot 接入令牌(不再用固定值)
  OB_TOKEN="$(openssl rand -hex 16)"
  sed -i "s|^ONE_BOT_ACCESS_TOKEN=.*|ONE_BOT_ACCESS_TOKEN=$OB_TOKEN|" "$APP_DIR/.env"
  echo "  已生成 OneBot 接入令牌(见 $APP_DIR/.env 的 ONE_BOT_ACCESS_TOKEN)"
  if [ -n "$DOMAIN" ]; then
    echo "  ⚠️ 记得在 .env 里补 BARK_URL / VAPID_* 等推送配置"
  fi
fi
chmod 600 "$APP_DIR/.env"
chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/.env"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$APP_DIR/data" "$APP_DIR/backups"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

# ─────────────────────────────────────────────────────────────
log "[7/8] 安装 systemd 单元 + 备份定时器"
install -m 644 "$APP_DIR"/deploy/systemd/*.service /etc/systemd/system/
install -m 644 "$APP_DIR"/deploy/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now msg2todo.service
systemctl enable --now msg2todo-backup.timer
sleep 3
systemctl is-active msg2todo.service || die "msg2todo 启动失败,请查看:journalctl -u msg2todo -n 50"

if [ -n "$QQ_NUMBER" ]; then
  log "[7b/8] 安装 NapCat(公共机器人 $QQ_NUMBER)"
  echo "  注意:该步骤依赖 NapCat 官方发布包,版本对不上时需要手工调整"
  NC_VERSION="${NC_VERSION:-v4.18.33}"
  NC_DIR="/opt/QQ-napcat"
  if [ ! -d "$NC_DIR/resources/app/app_launcher/napcat" ]; then
    mkdir -p "$NC_DIR"
    NC_URL="https://github.com/NapNeko/NapCatQQ/releases/download/$NC_VERSION/NapCat.Shell.zip"
    [ "$MIRROR" = "1" ] && NC_URL="https://ghfast.top/$NC_URL"
    curl -fsSL "$NC_URL" -o /tmp/napcat.zip || die "下载 NapCat.Shell.zip 失败($NC_VERSION 可能已下架,请到 GitHub Releases 查最新 tag 后设 NC_VERSION=)"
    unzip -oq /tmp/napcat.zip -d "$NC_DIR/resources/app/app_launcher/napcat"
    rm -f /tmp/napcat.zip
    echo "  NapCat 解压完成 → $NC_DIR/resources/app/app_launcher/napcat"
    echo "  还需手工完成(参考 README):复制官方 QQ 到 $NC_DIR、写 loadNapCat.js、"
    echo "  在 onebot11_$QQ_NUMBER.json 里配置反向 WS → ws://127.0.0.1:3001 与 ONE_BOT_ACCESS_TOKEN"
  else
    echo "  NapCat 已存在,跳过"
    echo "  ⚠️ 如需升级:修改 deploy/systemd/napcat.service 中的 QQ 号后 systemctl restart napcat"
  fi
  install -m 644 "$APP_DIR/deploy/systemd/napcat.service" /etc/systemd/system/
  systemctl daemon-reload
  echo "  用 systemctl start napcat 启动,并从 napcat/cache/qrcode.png 取二维码扫码"
else
  log "[7b/8] 跳过 NapCat 安装(未提供 QQ_NUMBER)"
fi

# ─────────────────────────────────────────────────────────────
log "[8/8] HTTPS(Caddy)"
if [ -n "$DOMAIN" ]; then
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  sed "s|112358wang\.xyz|$DOMAIN|g; s|www\.$DOMAIN|www.$DOMAIN|g" \
    "$APP_DIR/deploy/caddy/Caddyfile" > /etc/caddy/Caddyfile
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  echo "  Caddy 已配置域名 $DOMAIN"
  echo "  ⚠️ 前提:该域名已解析到本机公网 IP,且安全组放行 80/443,否则证书签不下来"
else
  echo "  未提供 DOMAIN,跳过 HTTPS 配置(仅 HTTP)"
fi

# ─────────────────────────────────────────────────────────────
IP="$(curl -fsS -m 10 https://ifconfig.me 2>/dev/null || echo '<服务器IP>')"
cat <<EOF

✅ 部署完成
   本机服务: http://127.0.0.1:8080
   $( [ -n "$DOMAIN" ] && echo "对外地址: https://$DOMAIN" || echo "对外地址: http://$IP:8080(未配 HTTPS)" )

   自检:
     systemctl is-active msg2todo napcat caddy
     systemctl list-timers msg2todo-backup.timer
     curl -fsS -H "x-auth-token: \$WEB_AUTH_TOKEN" http://127.0.0.1:8080/api/status

   安全组建议(阿里云控制台):
     ✅ 22(限制为常用 IP) ✅ 80 ✅ 443
     ❌ 8080(改由 Caddy 反代) ❌ 3001(改由 Caddy /onebot 提供 wss) ❌ 6099

   下一步:
     1. 取二维码扫码登录机器人: $NC_DIR/resources/app/app_launcher/napcat/cache/qrcode.png
     2. 迁移历史数据: 把本地 data/todos.db 上传到 $APP_DIR/data/ 后 systemctl restart msg2todo
     3. 打安卓包: SERVER=https://$DOMAIN bash scripts/build-apk.sh(在开发机执行)

   ⚠️ 部署完请立刻确认 .env 里的密钥是新的,并轮换此前泄露过的所有凭证。
EOF
