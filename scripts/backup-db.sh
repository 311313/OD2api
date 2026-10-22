#!/usr/bin/env bash
# opendesign2api SQLite 备份。
#
# 关键是 WAL 模式：直接 cp 数据文件会丢 WAL 里还没 checkpoint 的写入
# （实测生产环境 gateway.db-wal 常驻 4MB）。所以必须走 checkpoint 或
# sqlite 的在线备份接口。
#
# 优先顺序：
#   1. 宿主机有自己的 sqlite3 → .backup（最正确，WAL 安全）
#   2. 没有 sqlite3，但有 docker → 在容器内 VACUUM INTO（node:sqlite
#      没有 backup()，但 SQL 层的 VACUUM INTO 等价且可用）
#   3. 都没有 → 报错退出，绝不静默产出半截文件
#
# cron: 0 */6 * * *
set -euo pipefail

APP_DIR="${OD2API_DIR:-$HOME/opendesign2api}"
DATA_DIR="${1:-$APP_DIR/data}"
BACKUP_DIR="${2:-$APP_DIR/backups}"
KEEP="${KEEP:-14}"
CONTAINER="${CONTAINER:-opendesign2api}"

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/gateway-$STAMP.db"

# 临时文件：容器内写，成功后原子改名，避免半截文件占用备份名额
TMP="$OUT.part"

cleanup() { rm -f "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

backup_ok=0

# ── 方案 1：宿主机 sqlite3 ──
if command -v sqlite3 >/dev/null 2>&1; then
  if sqlite3 "$DATA_DIR/gateway.db" ".backup '$TMP'" 2>/dev/null; then
    backup_ok=1
    echo "via: sqlite3 .backup"
  fi
fi

# ── 方案 2：容器内 VACUUM INTO ──
# node:sqlite 没有 backup()（实测 undefined），但 VACUUM INTO 是 SQL 层
# 支持的原子导出，等价于在线备份，且会包含 WAL 中已提交的数据。
if [ "$backup_ok" = 0 ] && command -v docker >/dev/null 2>&1; then
  # 容器里写到 /app/data/（可写挂载），宿主机侧就是 $DATA_DIR
  TMP_NAME=".backup-$STAMP.db"
  if sudo -n docker exec "$CONTAINER" node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/app/data/gateway.db');
    try {
      db.exec(\"VACUUM INTO '/app/data/$TMP_NAME'\");
    } finally { db.close(); }
  " 2>/dev/null; then
    if [ -f "$DATA_DIR/$TMP_NAME" ]; then
      mv -f "$DATA_DIR/$TMP_NAME" "$TMP"
      backup_ok=1
      echo "via: VACUUM INTO (container)"
    fi
  fi
  # 失败时清掉容器内残留
  rm -f "$DATA_DIR/$TMP_NAME" 2>/dev/null || true
fi

if [ "$backup_ok" = 0 ]; then
  echo "备份失败：sqlite3 与容器 VACUUM INTO 均不可用，未产出文件" >&2
  exit 1
fi

# ── 校验：必须是一个完整可读的 SQLite 库 ──
SIZE=$(stat -c %s "$TMP" 2>/dev/null || echo 0)
if [ "$SIZE" -lt 4096 ]; then
  echo "备份失败：文件过小（$SIZE 字节），可能是空库" >&2
  exit 1
fi
if [ "$(head -c 15 "$TMP")" != "SQLite format 3" ]; then
  echo "备份失败：不是 SQLite 文件" >&2
  exit 1
fi
# 有 sqlite3 就跑 integrity_check，没有就靠文件头判断
if command -v sqlite3 >/dev/null 2>&1; then
  RES=$(sqlite3 "$TMP" "PRAGMA integrity_check;" 2>&1 | head -1)
  if [ "$RES" != "ok" ]; then
    echo "备份失败：integrity_check = $RES" >&2
    exit 1
  fi
fi

mv -f "$TMP" "$OUT"
trap - EXIT

# ── 轮转 ──
ls -1t "$BACKUP_DIR"/gateway-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do
  rm -f "$f"
done

echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
