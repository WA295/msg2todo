# 🤖 用自己的 QQ 当机器人(分布式模式)

除了使用公共机器人(加 2127511079 好友发消息),每个学生还可以**让自己的 QQ 号直接连到 iTodo**:
自己 QQ 收到的消息(好友私聊、班群通知)会自动提取成**自己的**待办,自己的提醒也推回自己的 QQ。

## 前提

1. 先在 iTodo App/网页里用**自己的 QQ 号登录绑定**(学生登录入口)
2. 自己的设备上装一个 OneBot 桥接(三选一):

| 方案 | 平台 | 门槛 |
|------|------|------|
| **LLOneBot** | Windows | 低,图形界面,QQNT 插件 |
| **NapCatQQ** | Windows / Linux | 中,命令行 |
| **Shamrock** | 安卓 | 高,需 root |

## 连接参数(所有方案通用)

```
服务器地址: ws://182.92.163.6:3001
接入令牌:   itodo3001
```

## Windows + LLOneBot(推荐给学生)

1. 安装最新版 QQ(Windows)
2. 下载 LLOneBot:https://github.com/LLOneBot/LLOneBot/releases(国内网络用 ghfast.top 前缀)
3. QQ 设置里加载 LLOneBot 插件(按官方说明操作)
4. 打开 LLOneBot 设置 → 「反向 WebSocket」:
   - 地址填 `ws://182.92.163.6:3001`
   - 令牌填 `itodo3001`
5. 保存 → 连接成功后,iTodo 会识别你的 QQ 号

## Linux + NapCat

见 README「QQ 接入(OneBot v11)」,把反向 WS 地址换成:
`ws://182.92.163.6:3001?access_token=itodo3001`

## 使用说明

- 你的 QQ 收到的**所有消息**都会尝试提取待办(含班群通知、老师私聊)
- 你自己发出的消息也会被处理:可以给「文件传输助手」发指令(课表/番茄/快递…)
- 你的待办、提醒全部归到你名下,和 App 里看到的一致
- 想退出:关闭桥接程序即可

## 管理员必读

- 服务器端口 3001 需在安全组放行
- 令牌 `ONE_BOT_ACCESS_TOKEN` 在云端 `.env` 配置,可自行修改
- 学生 QQ 号需先在 App 绑定过,否则按公共机器人逻辑处理
