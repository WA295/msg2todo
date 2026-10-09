/** 打包时内置的服务器配置(安卓 App 打开即用;改了这里要重新 build:apk)
 *
 *  此文件由 scripts/build-apk.sh 在打包时自动覆写:
 *      SERVER=<你的服务器地址> bash scripts/build-apk.sh
 *  仓库里不保留任何真实服务器地址与令牌(此前内置了生产 IP,已移除)。 */
window.APP_CONFIG = {
  server: '',
  authToken: '',
  versionCode: 4,
  versionName: '1.3',
};
