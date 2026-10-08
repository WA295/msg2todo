#!/usr/bin/env bash
# 打包安卓 APK(release 正式签名版,可覆盖升级、风险提示更少)
# 依赖:Java 17+、Android SDK(默认 ~/android-sdk,可用 ANDROID_HOME 覆盖)
# 签名:读取 android/keystore.properties + android/itodo-release.jks(勿提交到 Git)
set -e
cd "$(dirname "$0")/.."

export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
if [ ! -d "$ANDROID_HOME/platform-tools" ]; then
  echo "❌ 未找到 Android SDK($ANDROID_HOME)。请先安装或设置 ANDROID_HOME"
  exit 1
fi

echo "═══ 打包安卓 APK ═══"

# 内置服务器配置 + 版本号(每次打包都重写;SERVER/TOKEN 可用环境变量覆盖)
S="${SERVER:-$(grep -oP "(?<=server: ')[^']+" public/app-config.js 2>/dev/null)}"
S="${S:-http://182.92.163.6:8080}"
T="${TOKEN:-$(grep -oP "(?<=authToken: ')[^']*" public/app-config.js 2>/dev/null)}"
VC=$(grep -E '^VERSION_CODE=' android/gradle.properties | cut -d= -f2 | tr -d ' ')
VN=$(grep -E '^VERSION_NAME=' android/gradle.properties | cut -d= -f2 | tr -d ' ')
VC=${VC:-1}; VN=${VN:-1.0}
echo "内置服务器: ${S%/}  访问令牌: ${T:+已设置}  版本: $VN($VC)"
{
  echo '/** 打包时内置的服务器配置(安卓 App 打开即用;改了这里要重新 build:apk) */'
  echo 'window.APP_CONFIG = {'
  echo "  server: '${S%/}',"
  echo "  authToken: '$T',"
  echo "  versionCode: $VC,"
  echo "  versionName: '$VN',"
  echo '};'
} > public/app-config.js
echo "{\"versionCode\":$VC,\"versionName\":\"$VN\"}" > public/app-version.json

npx cap sync android

# 关键:删除被同步进 WebView 资源的 .apk,避免"APK 套娃 APK"导致体积暴涨、被安全扫描误判
find android/app/src/main/assets/public -type f -name '*.apk' -delete 2>/dev/null || true

cd android
./gradlew assembleRelease

APK="app/build/outputs/apk/release/app-release.apk"
if [ -f "$APK" ]; then
  mkdir -p ../dist
  cp "$APK" ../dist/msg2todo-安卓.apk
  cp "$APK" ../public/app.apk
  echo "✅ 打包完成: dist/msg2todo-安卓.apk ($(du -h "$APK" | cut -f1))"
  echo "   手机下载: http://<电脑IP>:8080/app.apk(需与电脑同一网络)"
else
  echo "❌ 打包失败,请查看上方错误"
  exit 1
fi
