# Windows 版安装教程(给朋友)

朋友拿到手的东西:一个压缩包(`msg2todo-win-x64.zip`)+ 这篇教程。

## 第一步:安装待办助手

1. 右键 `msg2todo-win-x64.zip` → 全部解压(比如解压到桌面)
2. 进入解压出的 `win-unpacked` 文件夹,双击 **`msg2todo.exe`**
3. 首次运行杀毒软件可能提示,选「允许运行」
4. 弹出「待办助手」窗口(待办看板)即成功
5. 配置文件自动生成在:`C:\Users\<用户名>\AppData\Roaming\msg2todo\.env`(改配置用记事本编辑,改完重启软件)

> 可以把 `msg2todo.exe` 右键「发送到 → 桌面快捷方式」,以后直接点快捷方式。

## 第二步:装 QQ 机器人(LLOneBot)

1. 确认电脑装了 Windows 版 QQ(官方 NTQQ)
2. 下载 LLOneBot 安装器(国内镜像,直连 GitHub 可能打不开):
   ```
   https://ghfast.top/https://github.com/LLOneBot/LLOneBot/releases/latest/download/LLOneBot-Setup.exe
   ```
   如果这个链接慢,换 `ghproxy.net` 前缀:
   ```
   https://ghproxy.net/https://github.com/LLOneBot/LLOneBot/releases/latest/download/LLOneBot-Setup.exe
   ```
3. 双击运行安装器,它会把 LLOneBot 装进 QQ
4. 打开 QQ,进「设置」,左侧会出现 **LLOneBot** 面板

## 第三步:配置反向 WebSocket

1. QQ 设置 → LLOneBot → 「网络设置」
2. 在「反向 WebSocket 服务」里点添加,地址填:
   ```
   ws://127.0.0.1:3001
   ```
3. 保存。看到待办助手窗口顶部的 **QQ 状态变绿**就是连上了

## 第四步:手机看板 + 推送(可选)

**手机看板**(手机和电脑同一 WiFi):
- iPhone:Safari 打开 `http://电脑IP:8080` → 分享 → 添加到主屏幕
- 安卓:Chrome 打开同上 → 菜单 → 添加到主屏幕

**手机推送**:
- iPhone:装 **Bark**,把链接填进 `.env` 的 `BARK_URL=`
- 安卓:装 **PushDeer**,把 pushkey 填进 `.env` 的 `PUSHDEER_KEY=`

## 第五步:大模型(可选)

不配置也能用(内置中文规则识别「明天/周五/下午3点」等)。想要更聪明,任选其一,编辑 `.env`:

- **本地免费**:Windows 装 [Ollama](https://ollama.com/download/windows),启动后命令行跑 `ollama pull qwen2.5:3b`,然后 `.env` 里:
  ```
  LLM_BASE_URL=http://127.0.0.1:11434/v1
  LLM_API_KEY=ollama
  LLM_MODEL=qwen2.5:3b
  ```
- **云 API**(如 DeepSeek,需付费):`.env` 里填:
  ```
  LLM_BASE_URL=https://api.deepseek.com
  LLM_API_KEY=sk-xxx
  LLM_MODEL=deepseek-chat
  ```

## 使用

- 别人私聊朋友发「明天下午3点提醒我交作业」→ 自动生成待办
- 群里要 @朋友 才会处理(改 `QQ_PROCESS_ALL_GROUP=true` 可处理全部)
- 默认**不回复**对方(静默记录);想收到确认回复改 `REPLY_CONFIRM=true`

## 常见问题

- **QQ 没反应**:检查 LLOneBot 的反向 WS 地址、待办助手是否在运行、防火墙是否放行 3001
- **看板打不开**:确认待办助手在运行,浏览器访问 http://127.0.0.1:8080
- **大模型没生效**:看软件顶部状态条,「规则模式」说明没连上;检查 .env 和 Ollama 是否在跑
- **收不到推送**:检查 .env 里密钥是否填对,重启软件
