# deploy/ · 配置即代码

> 这个目录是为了修掉当前最大的部署问题:**systemd / Caddy / 备份定时器以前只存在于运维手册的文字里**,
> 仓库里一个文件都没有。换台机器必须照文档手工敲一遍,敲错没人提醒。
>
> 现在这些配置都是仓库里的真实文件,可以被 review、被 diff、被 `systemd-analyze verify`。

## 目录

```
deploy/
├── systemd/
│   ├── msg2todo.service         # 主服务:低权限用户 itodo、EnvironmentFile、加固选项
│   ├── napcat.service           # 公共 QQ 机器人(NapCat + xvfb 无头)
│   ├── msg2todo-backup.service  # 备份 oneshot 单元(以 itodo 身份跑)
│   └── msg2todo-backup.timer    # 每日 03:00,Persistent=true 补跑,带随机抖动
├── caddy/
│   └── Caddyfile                # 自动 HTTPS + 反代;`/app.apk` 直接发文件;`/onebot` wss 入口
└── env/
    └── production.env.example   # 生产 .env 模板(零真实密钥)
```

## 与旧方案的差异

| 项 | 旧(手册文字版) | 新(deploy/) |
|---|---|---|
| 主服务运行用户 | root(单元无 `User=`) | 专用 `itodo` 用户 + `NoNewPrivileges` / `ProtectSystem` / `PrivateTmp` |
| 配置来源 | 硬编码在脚本 heredoc 里 | `deploy/systemd/*` 可版本化,密钥走 `EnvironmentFile` |
| 备份定时器 | **不存在**(只有脚本头注释提过) | `msg2todo-backup.timer` 真实存在 |
| 备份同日重跑 | 直接失败(固定日期文件名) | 带时分秒,可重复;加 `integrity_check` + Bark 告警 + `flock` |
| HTTPS | 无(域名不解析) | `Caddyfile` 待域名落地即生效;SSE 已配 `flush_interval -1` |
| 公网暴露 | 8080 / 3001 直接开在公网 | 主服务只监听 `127.0.0.1`,3001 走 Caddy `/onebot` 的 wss |

## 上线步骤

```bash
# 0) 前提:域名已解析到本机公网 IP(否则 Caddy 签不到证书)
#    域名必须先在注册商处正常解析(本项目的域名曾长期处于 client hold → NXDOMAIN)

# 1) 低权限用户与目录
useradd --system --create-home --home-dir /opt/msg2todo --shell /usr/sbin/nologin itodo
install -d -o itodo -g itodo /opt/msg2todo/data /opt/msg2todo/backups

# 2) 生产 .env(权限收紧到 600)
cp deploy/env/production.env.example /opt/msg2todo/.env
#    填入 WEB_AUTH_TOKEN / ONE_BOT_ACCESS_TOKEN / BARK_URL / VAPID_* 等
chmod 600 /opt/msg2todo/.env && chown itodo:itodo /opt/msg2todo/.env

# 3) 装单元文件
cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now msg2todo napcat
systemctl enable --now msg2todo-backup.timer

# 4) HTTPS 反代
cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile   # 先把 example.com 改成你的域名
systemctl reload caddy

# 5) 验证
systemctl is-active msg2todo napcat caddy
systemctl list-timers msg2todo-backup.timer
curl -fsS -H "x-auth-token: $WEB_AUTH_TOKEN" http://127.0.0.1:8080/api/status
curl -fsS https://<你的域名>/                      # 200
sudo bash /opt/msg2todo/scripts/backup-db.sh       # 手工跑一次,确认能出快照
```

## 校验

```bash
# 单元文件语法(本地没有目标程序时 "is not executable" 属正常提示,不是语法错误)
systemd-analyze verify deploy/systemd/*.service deploy/systemd/*.timer

# Caddy 配置
caddy validate --config deploy/caddy/Caddyfile

# 备份脚本
bash -n scripts/backup-db.sh
```

## 安全组(阿里云控制台,无法脚本化)

| 端口 | 是否开放 | 说明 |
|---|---|---|
| 22 | ✅ 建议限制为你的常用 IP | SSH 仅公钥登录 |
| 80 | ✅ | Let's Encrypt HTTP-01 验证 + 跳转 443 |
| 443 | ✅ | 主入口 |
| 8080 | ❌ **关闭** | 改由 Caddy 反代,不再公网直连 |
| 3001 | ❌ **关闭** | 改由 Caddy `/onebot` 提供 wss |
| 6099 | ❌ | NapCat WebUI 只留本机(需要时用 SSH 隧道) |

> 若你把 3001 关掉,**学生个人机器人的连接地址必须同步改成 `wss://<域名>/onebot`**
> (见 `docs/个人QQ机器人.md`),否则他们的桥接会连不上。
