#!/usr/bin/env bash
# ═══ msg2todo 云服务器一键部署 ═══
# 在全新的 Ubuntu 22.04/24.04 服务器上以 root 运行:
#   bash deploy-cloud.sh
# 可选环境变量:
#   TOKEN=你的访问密码     看板访问令牌(强烈建议设置)
#   QQ_NUMBER=123456789   你的机器人 QQ 号(不填则跳过 NapCat 安装)
#   MIRROR=1              使用国内镜像下载(国内服务器建议加)
set -e

TOKEN="${TOKEN:-}"
QQ_NUMBER="${QQ_NUMBER:-}"
MIRROR="${MIRROR:-0}"
APP_DIR="/opt/msg2todo"

echo "═══ msg2todo 云部署开始 ═══"
echo "[0/7] 基础依赖..."
apt-get update -qq
apt-get install -y -qq curl git unzip ca-certificates > /dev/null

echo "[1/7] 安装 Node.js 22..."
if [ "$MIRROR" = "1" ]; then
  NODE_URL="https://npmmirror.com/mirrors/node/v22.14.0/node-v22.14.0-linux-x64.tar.xz"
else
  NODE_URL="https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz"
fi
curl -sL "$NODE_URL" -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
node --version

echo "[2/7] 拉取代码..."
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull
else
  REPO="https://github.com/WA295/msg2todo.git"
  [ "$MIRROR" = "1" ] && REPO="https://ghfast.top/$REPO"
  git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "[3/7] 安装依赖..."
[ "$MIRROR" = "1" ] && npm config set registry https://registry.npmmirror.com
npm install --no-audit --no-fund > /dev/null

echo "[4/7] 配置 .env..."
[ -f .env ] || cp .env.example .env
# 生成访问令牌
if [ -n "$TOKEN" ]; then
  sed -i "s|^WEB_AUTH_TOKEN=.*|WEB_AUTH_TOKEN=$TOKEN|" .env
  grep -q "^WEB_AUTH_TOKEN=" .env || echo "WEB_AUTH_TOKEN=$TOKEN" >> .env
fi
# 云端:OneBot 只监听本机(安全),NapCat 与 msg2todo 同机通信
grep -q "^ONE_BOT_WS_HOST=" .env || echo "ONE_BOT_WS_HOST=127.0.0.1" >> .env
sed -i "s|^WECHAT_ENABLED=.*|WECHAT_ENABLED=false|" .env
grep -q "^WECHAT_ENABLED=" .env || echo "WECHAT_ENABLED=false" >> .env
[ -n "$WEATHER_CITY" ] && { grep -q "^WEATHER_CITY=" .env || echo "WEATHER_CITY=$WEATHER_CITY" >> .env; }

echo "[5/7] 安装 systemd 服务..."
cat > /etc/systemd/system/msg2todo.service <<EOF
[Unit]
Description=msg2todo 校园生活管家
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=/usr/local/bin/node $APP_DIR/src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now msg2todo
sleep 3
systemctl is-active msg2todo

if [ -n "$QQ_NUMBER" ]; then
  echo "[6/7] 安装 NapCat(QQ 机器人,账号 $QQ_NUMBER)..."
  mkdir -p /opt/QQ-napcat
  # 下载 QQ Linux
  curl -sL -o /tmp/qq.deb "https://dldir1.qq.com/qqfile/qq/QQNT/Linux/QQ_3.2.13_240617_amd64_01.deb" || true
  [ -f /tmp/qq.deb ] && dpkg -i /tmp/qq.deb || apt-get -f install -y -qq
  if [ -d "/opt/QQ" ]; then
    cp -a /opt/QQ "$APP_DIR/QQ-napcat" 2>/dev/null || cp -a /opt/QQ /opt/QQ-napcat 2>/dev/null || true
  fi
  echo "  NapCat 安装请参考 README「QQ 接入」章节(需下载 NapCat.Shell.zip 并打补丁)"
  echo "  之后用 systemd 无头模式启动(参考仓库 WIN-SETUP/README 中 napcat.service 示例)"
else
  echo "[6/7] 跳过 QQ 机器人安装(未提供 QQ_NUMBER)"
fi

echo "[7/7] 防火墙放行 8080..."
if command -v ufw >/dev/null; then
  ufw allow 8080/tcp > /dev/null 2>&1 || true
fi

IP=$(curl -s ifconfig.me || echo "<服务器IP>")
echo ""
echo "✅ 部署完成!"
echo "   看板地址: http://$IP:8080"
[ -n "$TOKEN" ] && echo "   访问密码: $TOKEN(手机 App 打包时用 TOKEN=$TOKEN 内置)"
echo "   验证服务: systemctl status msg2todo"
echo ""
echo "   下一步:"
echo "   1. 若装了 QQ 机器人:安装 NapCat 后重启服务,扫码登录"
echo "   2. 迁移数据:本地 data/todos.db 上传到 $APP_DIR/data/"
echo "   3. 重新打安卓包: SERVER=http://$IP:8080 TOKEN=$TOKEN bash scripts/build-apk.sh"
