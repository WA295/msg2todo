#!/usr/bin/env bash
# 把 msg2todo 桌面版安装到应用菜单(不依赖 FUSE,适合没有 libfuse2 的系统)
# 用法: bash scripts/install-desktop.sh
set -euo pipefail

cd "$(dirname "$0")/.."

SRC_DIR="dist/linux-unpacked"
if [ ! -x "$SRC_DIR/msg2todo" ]; then
  echo "错误: 未找到 $SRC_DIR/msg2todo,请先运行: npm run dist:linux" >&2
  exit 1
fi

APP_DIR="${HOME}/Applications/msg2todo"
ICON_DIR="${HOME}/.local/share/icons/hicolor/256x256/apps"
DESKTOP_DIR="${HOME}/.local/share/applications"

echo "==> 安装到 $APP_DIR"
mkdir -p "${HOME}/Applications"
rm -rf "$APP_DIR"
cp -r "$SRC_DIR" "$APP_DIR"

echo "==> 安装图标"
mkdir -p "$ICON_DIR"
cp -f build/icon.png "$ICON_DIR/msg2todo.png"

echo "==> 创建应用菜单项"
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/msg2todo.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=待办助手
Name[en]=msg2todo
Comment=微信/QQ 消息自动生成待办
Exec=${APP_DIR}/msg2todo
Icon=msg2todo
Terminal=false
Categories=Utility;
StartupWMClass=msg2todo
EOF
chmod +x "$DESKTOP_DIR/msg2todo.desktop"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" || true

echo ""
echo "✅ 安装完成!现在可以从应用菜单找到「待办助手」双击启动了。"
echo "   配置文件: ~/.config/msg2todo/.env (首次运行自动生成)"
echo "   卸载: rm -rf ${APP_DIR} ${DESKTOP_DIR}/msg2todo.desktop ${ICON_DIR}/msg2todo.png"
