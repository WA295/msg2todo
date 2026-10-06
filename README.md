# msg2todo 📝

实时接收**微信**和 **QQ** 的消息,用 **LLM 大模型**自动识别其中的待办事项(时间、优先级、备注),存入本地 **SQLite**,并提供一个 **Web 看板**查看和管理。

支持两种使用方式:**桌面软件**(Electron,双击即用,推荐)和 **命令行服务**。

## 本机实际部署(已配置好)

当前机器上的完整链路:

| 组件 | 位置 | 说明 |
|------|------|------|
| QQ 机器人 | `~/Applications/QQ-napcat/` | QQ 副本 + NapCat v4.18.30,菜单里点「QQ」即启动(带 `-q` 自动登录) |
| 待办助手 | `~/Applications/msg2todo/` | 桌面软件,看板 8080 / OneBot 接入 3001 |
| 本地大模型 | `~/msg2todo-llm/server.py` | Qwen2.5-3B-Instruct,OpenAI 兼容接口 11434,GPU 推理 |
| 配置文件 | `~/.config/msg2todo/.env` | QQ/LLM/过滤规则配置 |
| 数据 | `~/.config/msg2todo/todos.db` | SQLite |
| 开机自启 | `~/.config/autostart/` | 三个组件随登录自动启动 |

NapCat 反向 WS 已配好(`ws://127.0.0.1:3001`),重启机器后全自动恢复。

```
┌──────────┐  反向 WebSocket   ┌──────────────────────────────┐
│ LLOneBot │ ────────────────► │  msg2todo                    │
│ /NapCat  │                   │  ├─ OneBot v11 服务 (ws)      │   LLM API
└──────────┘                   │  ├─ wechaty (个人微信)        │ ─────────► 提取待办
┌──────────┐                   │  ├─ LLM / 本地规则提取        │
│ 微信      │ ────────────────► │  ├─ SQLite 存储              │
└──────────┘                   │  └─ 看板 (桌面窗口 / 浏览器)  │
                               └──────────────────────────────┘
```

## 方式一:桌面软件(推荐)

```bash
npm install
npm run desktop        # 开发模式直接运行
npm run dist:linux     # 打包成 AppImage,产物在 dist/
```

打包后得到 `dist/msg2todo-1.0.0.AppImage`(135MB),两种用法:

**用法 A:AppImage 直接双击**

```bash
chmod +x dist/msg2todo-1.0.0.AppImage
./dist/msg2todo-1.0.0.AppImage
```

> AppImage 需要系统的 FUSE 支持。若提示 `error loading libfuse.so.2`,任选其一:
> - 安装 FUSE:`sudo apt install libfuse2`(推荐,一次装好以后所有 AppImage 都能双击)
> - 或加参数运行:`./dist/msg2todo-1.0.0.AppImage --appimage-extract-and-run`

**用法 B:安装到应用菜单(不需要 FUSE)**

```bash
bash scripts/install-desktop.sh
```

装完后从应用菜单搜索「待办助手」双击启动(免 FUSE)。卸载:`rm -rf ~/Applications/msg2todo ~/.local/share/applications/msg2todo.desktop`

桌面版特性:

- **窗口内嵌看板**:启动即显示待办看板,无需开浏览器
- **微信扫码登录**:微信登录二维码直接弹窗显示在窗口里,不再依赖终端
- **系统托盘常驻**:关闭窗口只是收起,托盘图标常驻后台;托盘菜单可退出
- **顶部状态条**:实时显示 微信/QQ 连接状态和 LLM 模式
- **配置位置**:首次运行自动在 `~/.config/msg2todo/.env` 生成配置文件(数据在 `~/.config/msg2todo/todos.db`)

> 打包时若网络受限(GitHub 不可达),用国内镜像:
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries npm run dist:linux`

## 方式二:命令行服务

```bash
# 1. 安装依赖(Node >= 22.5)
npm install

# 2. 配置
cp .env.example .env
vim .env   # 至少填 LLM_API_KEY

# 3. 启动
npm start
```

启动后:

- **Web 看板**: http://127.0.0.1:8080
- **QQ 接入点**: `ws://<本机IP>:3001`(供 LLOneBot/NapCat 反向连接)
- **微信**:终端会打印二维码,手机微信扫码登录

## QQ 接入(OneBot v11)

本服务实现了 OneBot v11 的**反向 WebSocket 服务端**,任选一个 QQ 机器人插件:

| 插件 | 平台 | 说明 |
|------|------|------|
| [LLOneBot](https://github.com/LLOneBot/LLOneBot) | Windows NTQQ | 最常用,配置里添加反向 WebSocket |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) | Win/Linux/容器 | 功能全,WebUI 里配置 |

插件里添加反向 WebSocket:

```
ws://127.0.0.1:3001        # 插件与本服务同机
ws://192.168.x.x:3001      # 不同机器时填本服务的局域网 IP
```

若在 `.env` 里设置了 `ONE_BOT_ACCESS_TOKEN`,插件端的 token 要一致(插件会通过请求头 `Authorization: Bearer <token>` 带上)。

### 行为规则

- **私聊**:所有消息都会交给 LLM 判断是否包含待办
- **群聊**:默认只处理 **@机器人** 的消息(`QQ_PROCESS_ALL_GROUP=true` 可改为处理全部)

## 微信接入(wechaty)

> ⚠️ **重要提醒(2026 年)**:个人微信的网页版协议已被微信官方彻底封禁(服务器返回 1203「当前微信版本过低,暂无法登录」)。免费的 `wechat4u` puppet 已无法登录,这不是本软件的 bug。
>
> 可行替代方案:
> - **padlocal**(付费 iPad 协议,约 ¥200/年,稳定):`.env` 里设 `WECHAT_PUPPET=padlocal` 和 `WECHAT_PUPPET_TOKEN=puppet_xxx`,其余代码无需改动
> - **企业微信官方 API**(免费稳定,需注册企业微信 + 内网穿透做回调,欢迎提需求我来实现)
> - **只用 QQ**(QQ 走 OneBot 协议完全正常),微信消息在看板里手动添加

微信启用时(`WECHAT_ENABLED=true`),终端/窗口会打印二维码,手机微信扫码即可登录。

群聊同样默认只处理 @机器人 的消息(`WECHAT_PROCESS_ALL_GROUP=true` 改为处理全部)。

## LLM 配置(OpenAI 兼容接口)

`.env` 里填任意 OpenAI 兼容服务,例如:

**DeepSeek**(默认):
```
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-chat
```

**OpenAI**:
```
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
```

**本地 Ollama**:
```
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen2.5:7b
```

> 不填 `LLM_API_KEY` 也能跑:自动降级为**本地规则提取**(支持「明天/周五/下午3点/3小时后」等常见表达,但识别不了复杂自然语言)。

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
| `WECHAT_ENABLED` | `true` | 是否启用微信 |
| `WECHAT_PUPPET` | `wechaty-puppet-wechat4u` | puppet;可用 `padlocal` |
| `WECHAT_PUPPET_TOKEN` | 空 | padlocal token |
| `WECHAT_PROCESS_ALL_GROUP` | `false` | 是否处理微信群全部消息 |
| `TODO_KEYWORDS` | 空 | 关键词预过滤,如 `提醒,记得,待办`;留空则私聊/被@都送 LLM |
| `REPLY_CONFIRM` | `true` | 添加成功后是否回复发送者确认 |
| `DB_PATH` | `data/todos.db` | SQLite 路径 |

## 使用示例

给机器人发:

- 「明天下午3点提醒我交高数作业」
- 「周五下班前把实验报告发我,很重要」(群里要 @机器人)
- 「下周一上午9点半开组会,记得带电脑」
- 「3小时后提醒我吃药」

机器人回复确认,同时待办出现在看板上:

```
✅ 已记下待办:交高数作业 · 明天 15:00
```

## 本地测试(无需真实 QQ/微信)

```bash
npm start                          # 先启动服务
npm run simulate                   # 另开终端,模拟 QQ 客户端发测试消息
npm run mock-llm                   # (可选)本地模拟 LLM 接口,测试 LLM 链路
```

LLM 链路测试方式:

```bash
node scripts/mock-llm.js 9099 &    # 模拟 LLM,监听 9099
LLM_BASE_URL=http://127.0.0.1:9099 LLM_API_KEY=x npm start
npm run simulate
```

## 常见问题

- **微信扫码后频繁掉线/收不到消息**:web 协议风控所致,建议换 padlocal 付费 puppet,或改用企业微信官方 API。
- **QQ 收不到消息**:确认插件里反向 WebSocket 地址、端口正确;若跨机器,检查防火墙放行 3001 端口。
- **群消息没反应**:默认只处理 @机器人 的消息;需要处理全部请改 `*_PROCESS_ALL_GROUP`。
- **LLM 识别不准**:换更强的模型,或设置 `TODO_KEYWORDS` 预过滤减少无关消息进入 LLM。
- **端口冲突**:改 `WEB_PORT` / `ONE_BOT_WS_PORT`。
