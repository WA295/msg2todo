#!/usr/bin/env bash
# msg2todo 数据库备份:VACUUM INTO 生成干净快照,保留最近 14 份
# 配合 systemd timer 每日 03:00 执行
set -e
APP_DIR="/opt/msg2todo"
BACKUP_DIR="$APP_DIR/backups"
mkdir -p "$BACKUP_DIR"

DATE=$(date +%F)
DEST="$BACKUP_DIR/todos-$DATE.db"

/usr/local/bin/node --dns-result-order=ipv4first -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$APP_DIR/data/todos.db');
db.exec(\"VACUUM INTO '$DEST'\");
db.close();
"

echo "备份完成: $DEST ($(du -h "$DEST" | cut -f1))"
# 只保留最近 14 份
ls -t "$BACKUP_DIR"/*.db 2>/dev/null | tail -n +15 | xargs -r rm -f
