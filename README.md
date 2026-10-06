# msg2todo 📝

实时接收 **QQ**(和微信)的消息,用 **LLM 大模型**自动识别其中的待办事项(时间、优先级、备注),存入本地 **SQLite**,提供 **桌面看板 + 手机看板(PWA)+ 手机实时推送**,全程免费、数据不出本机。

```
┌──────────┐  反向 WebSocket   ┌──────────────────────────────┐
│ LLOneBot │ ────────────────► │  msg2todo                    │
│ /NapCat  │                   │  ├─ OneBot v11 服务 (ws)      │   LLM API
└──────────┘                   │  ├─ LLM / 本地规则提取        │   (云端/本地)
                               │  ├─ SQLite 存储              │
┌──────────┐                   │  ├─ 桌面看板 (Electron)      │
│ 微信      │ ──(已停用)──────► │  ├─ 手机看板 (PWA)           │
└──────────┘                   │  └─ 手机推送 (Bark/PushDeer) │
                               └──────────────────────────────┘
```

## 功能特性

- 🤖 **QQ 机器人**:OneBot v11 反向 WebSocket,支持 LLOneBot(Windows)/ NapCat(Linux/Windows)
- 🧠 **智能提取**:本地大模型(如 Qwen2.5-3B,GPU 推理)或任意 OpenAI 兼容 API;无 LLM 时自动降级为内置中文规则(支持「明天/周五/下午3点/3小时后」等)
- 🖥️ **桌面软件**:Electron 窗口内嵌看板、系统托盘、开机自启
- 📱 **手机看板**:PWA,浏览器「添加到主屏幕」即用,和 App 一样
- 🔔 **手机推送**:新待办、到期提醒实时推送到手机(Bark for iOS / PushDeer for Android)
- 🤫 **默认静默**:生成待办不打扰发消息的人(可配置开启确认回复)
- 🔒 **隐私**:数据全部本地存储,大模型可跑在本地显卡

## 快速开始(Linux)

```bash
npm install               # Node >= 22.5
cp .env.example .env      # 按需填写 LLM / 推送配置
npm run desktop           # 开发模式直接运行桌面版
# 或 npm start            # 纯命令行模式
```

打包发行版:

```bash
npm run dist:linux                    # AppImage,产物在 dist/
npm run dist:win  # 需要 wine;     # Windows 安装包
bash scripts/install-desktop.sh       # Linux 免 FUSE 安装到应用菜单
```

> GitHub 不可达时打包加国内镜像:
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries npm run dist:linux`

### Windows 版

Windows 用户见 **[WIN-SETUP.md](./WIN-SETUP.md)**:解压运行 exe + LLOneBot 插件,三步配好。

## QQ 接入(OneBot v11)

本服务实现 OneBot v11 的**反向 WebSocket 服务端**(默认监听 3001),任选一个 QQ 机器人插件:

| 插件 | 平台 | 说明 |
|------|------|------|
| [LLOneBot](https://github.com/LLOneBot/LLOneBot) | Windows NTQQ | 有安装器和图形设置面板,最易上手 |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) | Win/Linux/容器 | 功能全,Linux 免 root 部署方式见下文 |

在插件中添加反向 WebSocket:

```
ws://127.0.0.1:3001        # 同机
ws://192.168.x.x:3001      # 跨机填局域网 IP
```

### Linux 免 sudo 部署 NapCat(实测可用)

```bash
# 1. 下载 NapCat.Shell.zip(国内镜像):
curl -sL -o napcat.zip 'https://ghfast.top/https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.30/NapCat.Shell.zip'
# 2. 复制 QQ 到用户目录并打补丁:
cp -a /opt/QQ ~/Applications/QQ-napcat
unzip -o napcat.zip -d ~/Applications/QQ-napcat/resources/app/app_launcher/napcat
echo "(async () => {await import('file:///$(echo ~)/Applications/QQ-napcat/resources/app/app_launcher/napcat/napcat.mjs');})();" > ~/Applications/QQ-napcat/resources/app/loadNapCat.js
node -e "const fs=require('fs');const p=process.env.HOME+'/Applications/QQ-napcat/resources/app/package.json';const j=JSON.parse(fs.readFileSync(p));j.main='./loadNapCat.js';fs.writeFileSync(p,JSON.stringify(j,null,2))"
# 3. 启动(首次需手机扫码,之后 -q 快速登录):
~/Applications/QQ-napcat/qq --no-sandbox -q <你的QQ号>
# 4. 首次登录后,把反向 WS 写入配置(文件名里的数字换成你的 QQ 号):
node -e "const fs=require('fs');const p=process.env.HOME+'/Applications/QQ-napcat/resources/app/app_launcher/napcat/config/onebot11_<QQ号>.json';const c=JSON.parse(fs.readFileSync(p));c.network.websocketClients=[{name:'msg2todo',enable:true,url:'ws://127.0.0.1:3001',messagePostFormat:'array',reportSelfMessage:false,reconnectInterval:5}];fs.writeFileSync(p,JSON.stringify(c,null,2))"
# 5. 重启 QQ 生效
```

### 行为规则

- **私聊**:所有消息交给 LLM 判断是否含待办
- **群聊**:默认只处理 **@机器人** 的消息(`QQ_PROCESS_ALL_GROUP=true` 处理全部)
- **静默**:默认不回复发送者;`REPLY_CONFIRM=true` 开启确认回复

## 微信接入(wechaty)

> ⚠️ **重要提醒(2026)**:个人微信的网页版协议已被微信官方封禁(服务器返回 1203「当前微信版本过低」)。免费的 `wechat4u` puppet 无法登录,这不是本软件的 bug。微信功能默认停用(`WECHAT_ENABLED=false`)。
>
> 替代方案:padlocal 付费 iPad 协议(`WECHAT_PUPPET=padlocal` + token),或企业微信官方 API。

## LLM 配置(OpenAI 兼容接口)

| 方式 | 配置示例 | 说明 |
|------|----------|------|
| 云端 API | `LLM_BASE_URL=https://api.deepseek.com` `LLM_API_KEY=sk-xxx` | 效果好,按量付费 |
| 本地 Ollama | `LLM_BASE_URL=http://127.0.0.1:11434/v1` `LLM_API_KEY=ollama` `LLM_MODEL=qwen2.5:7b` | 免费隐私,需显卡 |
| 不配置 | 留空 | 自动降级为内置中文规则 |

> 本地 GPU 方案(实测):Python + torch + Qwen2.5-3B-Instruct,参考 `~/msg2todo-llm/server.py` 部署(8GB 显存即可)。

## 手机使用

**看板(PWA)**:手机浏览器打开 `http://<电脑IP>:8080` → 「添加到主屏幕」。需与电脑同一 WiFi。

**推送(任何网络,推荐)**:

| 平台 | App | 配置 |
|------|-----|------|
| iOS | [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865) | `.env` 里 `BARK_URL=https://api.day.app/你的密钥` |
| Android | PushDeer | `.env` 里 `PUSHDEER_KEY=你的pushkey` |

新待办生成、待办到期都会实时推送到手机锁屏。

## 全部配置项

| 变量 | 默认 | 说明 |
|------|------|------|
| `LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容接口地址 |
| `LLM_API_KEY` | 空 | API Key;为空时用本地规则 |
| `LLM_MODEL` | `deepseek-chat` | 模型名 |
| `TZ` | `Asia/Shanghai` | 解析"明天/下午3点"等相对时间的时区 |
| `WEB_HOST` / `WEB_PORT` | `0.0.0.0` / `8080` | 看板监听 |
| `QQ_ENABLED` | `true` | 是否启用 QQ |
| `ONE_BOT_WS_HOST` / `ONE_BOT_WS_PORT` | `0.0.0.0` / `3001` | OneBot 反向 WS |
| `ONE_BOT_ACCESS_TOKEN` | 空 | 接入令牌(可选) |
| `QQ_PROCESS_ALL_GROUP` | `false` | 是否处理 QQ 群全部消息 |
| `WECHAT_ENABLED` | `true` | 是否启用微信(建议 false) |
| `TODO_KEYWORDS` | 空 | 关键词预过滤,如 `提醒,记得,待办`;留空则私聊/被@都送 LLM |
| `REPLY_CONFIRM` | `false` | 添加成功后是否回复发送者确认 |
| `BARK_URL` | 空 | Bark(iOS)推送地址 |
| `PUSHDEER_KEY` | 空 | PushDeer(Android)pushkey |
| `DB_PATH` | `data/todos.db` | SQLite 路径 |

## 使用示例

给机器人发(群里要 @机器人):

- 「明天下午3点提醒我交高数作业」
- 「周五下班前把实验报告发我,很重要」
- 「下周一上午9点半开组会,记得带电脑」
- 「3小时后提醒我吃药」

系统静默生成待办 → 存入看板 → 推送到手机(若已配置)。闲聊消息会被大模型/规则自动忽略。

## 本地测试(无需真实 QQ)

```bash
npm start                  # 启动服务
npm run simulate           # 模拟 QQ 客户端发测试消息
npm run mock-llm           # (可选)本地模拟 LLM 接口
```

## 常见问题

- **微信扫码后收不到消息**:2026 年起网页版微信协议已死,建议只用 QQ 或换 padlocal。
- **QQ 收不到消息**:检查插件反向 WS 地址;跨机检查防火墙 3001 端口;重连后若 @消息无效,确认服务端拿到了 self_id(日志「登录成功」)。
- **群消息没反应**:默认只处理 @机器人 的消息。
- **手机看板打不开**:手机和电脑需同一 WiFi,看板地址用电脑局域网 IP。
- **推送收不到**:检查 `.env` 密钥、手机网络;Bark/PushDeer 依赖对应 App 在线。
- **电脑关机后能不能用?**:不能,整个系统跑在电脑上。保持电脑开机(可合盖不睡眠),或部署到云服务器。
- **LLM 识别不准**:换更强的模型,或设置 `TODO_KEYWORDS` 预过滤。
- **端口冲突**:改 `WEB_PORT` / `ONE_BOT_WS_PORT`。

## 项目结构

```
src/                核心服务(OneBot/LLM/规则/存储/看板/推送)
desktop/            Electron 桌面版入口
public/             看板前端(PWA)
scripts/            打包/安装/模拟测试脚本
patches/            wechat4u 协议修复补丁(patch-package)
WIN-SETUP.md        Windows 版安装教程
```

## License

MIT
