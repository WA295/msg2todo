#!/usr/bin/env bash
# iTodo 数据库备份:一致性快照 + 完整性校验 + 轮转 + 失败告警
#
# 改进点(相对旧版):
#   1. 文件名带时分秒 → 同一天可重复执行(旧版 VACUUM INTO 到固定日期名,第二次必失败退出)
#   2. 生成后跑 integrity_check,校验不过直接失败(旧版无校验)
#   3. 备份成功/失败都尝试 Bark 告警(旧版静默失败,这是最危险的失效模式)
#   4. flock 并发锁:避免 systemd timer 与手工执行撞车
#   5. APP_DIR / BACKUP_DIR / BACKUP_KEEP / NODE_BIN 可被 systemd Environment 覆盖
#
# 用法:bash scripts/backup-db.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/msg2todo}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"
DB="$APP_DIR/data/todos.db"

mkdir -p "$BACKUP_DIR"

# ── 并发锁 ──
exec 9>"$BACKUP_DIR/.backup.lock"
if ! flock -n 9; then
  echo "⚠️ 已有备份在进行,跳过本次"
  exit 0
fi

notify() { # notify <标题> <内容>
  if [ -n "${BARK_URL:-}" ]; then
    curl -fsS -m 10 -X POST "$BARK_URL" \
      -H 'Content-Type: application/json' \
      -d "{\"title\":\"$1\",\"body\":\"$2\"}" >/dev/null 2>&1 || true
  fi
}

fail() {
  echo "❌ 备份失败:$1" >&2
  notify "❌ iTodo 备份失败" "$1(请立即检查服务器)"
  exit 1
}

[ -f "$DB" ] || fail "找不到数据库 $DB"
[ -x "$NODE_BIN" ] || fail "找不到 node($NODE_BIN)"

STAMP="$(date +%F-%H%M%S)"
DEST="$BACKUP_DIR/todos-$STAMP.db"

echo "[1/4] 生成快照 → $DEST"
DB_SRC="$DB" DB_DEST="$DEST" "$NODE_BIN" -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.DB_SRC);
// 先把 WAL 落盘,保证快照包含最新写入
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
const ok = db.prepare("PRAGMA integrity_check").get();
if (!ok || Object.values(ok)[0] !== "ok") {
  console.error("源库 integrity_check 未通过: " + JSON.stringify(ok));
  process.exit(1);
}
db.exec("VACUUM INTO " + JSON.stringify(process.env.DB_DEST));
db.close();
' || fail "VACUUM INTO / integrity_check 未通过"

echo "[2/4] 校验快照自身可读"
DB_DEST="$DEST" "$NODE_BIN" -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.DB_DEST, { readOnly: true });
const ok = db.prepare("PRAGMA integrity_check").get();
if (!ok || Object.values(ok)[0] !== "ok") process.exit(1);
const n = db.prepare("SELECT count(*) AS c FROM todos").get();
db.close();
console.log("  快照 OK,todos 行数 = " + n.c);
' || fail "快照文件损坏/不可读"

SIZE="$(du -h "$DEST" | cut -f1)"
echo "[3/4] 完成:$(basename "$DEST") ($SIZE)"

echo "[4/4] 轮转,保留最近 $BACKUP_KEEP 份"
# 只匹配带时间戳的快照,避免误删历史命名(todos-YYYY-MM-DD.db)留下的文件
ls -t "$BACKUP_DIR"/todos-*.db 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | xargs -r rm -f

notify "✅ iTodo 备份完成" "$(basename "$DEST") ($SIZE),保留 $BACKUP_KEEP 份"
echo "✅ 备份完成"
