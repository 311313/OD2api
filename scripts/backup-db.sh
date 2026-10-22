#!/usr/bin/env bash
# opendesign2api SQLite 备份：用 sqlite3 的 .backup 做热备（WAL 安全），
# 保留最近 14 份，超出删最旧。cron 建议：0 */6 * * *
set -euo pipefail

DATA_DIR="${1:-/home/ubuntu/opendesign2api/data}"
BACKUP_DIR="${2:-/home/ubuntu/opendesign2api/backups}"
KEEP=14

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/gateway-$STAMP.db"

if command -v sqlite3 >/dev/null 2>&1; then
  # 容器外有 sqlite3：直接对数据文件做在线备份
  sqlite3 "$DATA_DIR/gateway.db" ".backup '$OUT'"
elif command -v docker >/dev/null 2>&1; then
  # 没有 sqlite3 就借容器里的 node
  sudo -n docker exec opendesign2api node -e "
    const { DatabaseSync } = require('node:sqlite');
    const src = new DatabaseSync('/app/data/gateway.db', { readOnly: true });
    src.backup ? src.backup('$OUT') : console.error('node:sqlite backup 不可用');
    src.close();
  " 2>/dev/null || {
    # 兜底：停写风险最小的文件级拷贝（先 checkpoint）
    sudo -n docker exec opendesign2api node -e "
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync('/app/data/gateway.db');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
    "
    sudo -n cp "$DATA_DIR/gateway.db" "$OUT"
    sudo -n chown "$(id -u):$(id -g)" "$OUT"
  }
else
  echo "sqlite3 与 docker 都不可用" >&2
  exit 1
fi

# 轮转：保留最近 KEEP 份
ls -1t "$BACKUP_DIR"/gateway-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do
  rm -f "$f"
done

echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
