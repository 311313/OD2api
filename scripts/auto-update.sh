#!/usr/bin/env bash
# opendesign2api 自动更新：git pull → 变更才重建 → 健康检查 → 失败回退
#
# cron: */5 * * * * bash ~/opendesign2api/scripts/auto-update.sh >> ~/opendesign2api/auto-update.log 2>&1
#
# 安全设计：
#   - 只有 src/ 或 public/ 有实际变更才重建（文档/脚本变更不折腾容器）
#   - 健康检查 60s 不过就回退到上一个 commit 并重启
#   - 数据库在 ./data（gitignored），pull 永远不会碰数据
set -uo pipefail

APP=~/opendesign2api
cd "$APP" || exit 1
LOCK=/tmp/od2api-update.lock

# 防并发：上一轮还没跑完就跳过
exec 9>"$LOCK"
flock -n 9 || exit 0

# 只跟踪 fetch，不 merge —— 先看有没有变更再决定
git fetch origin main --quiet 2>/dev/null || { echo "[$(date '+%F %T')] fetch 失败（网络？）"; exit 1; }

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0   # 无更新，最常见路径，直接走

echo "[$(date '+%F %T')] 有更新: $LOCAL → $REMOTE"

# 记录部署前代码，回退用
PREV=$(git rev-parse HEAD)

# src/public 是否变更（决定要不要重建容器）
CHANGED=$(git diff --name-only HEAD origin/main -- src/ public/ | head -1)

git reset --hard origin/main --quiet
if [ -z "$CHANGED" ]; then
  echo "[$(date '+%F %T')] 仅文档/脚本变更，已拉取，无需重建"
  exit 0
fi

echo "[$(date '+%F %T')] src/public 有变更，重建容器…"
sudo -n docker compose up -d --build 2>&1 | tail -1

# 健康检查：60 秒内 /health 必须返回 ok
OK=0
for i in $(seq 1 12); do
  sleep 5
  H=$(sudo -n docker exec opendesign2api node -e '
    fetch("http://127.0.0.1:7890/health").then(r=>r.json()).then(j=>{
      console.log(j.ok?"OK":"BAD");
    }).catch(()=>console.log("BAD"));
  ' 2>/dev/null | tail -1)
  if [ "$H" = "OK" ]; then OK=1; break; fi
done

if [ "$OK" = 1 ]; then
  echo "[$(date '+%F %T')] ✓ 更新完成，健康检查通过 ($REMOTE)"
  # 清 /tmp 的部署残留
  rm -f /tmp/od.tar.gz
else
  echo "[$(date '+%F %T')] ✗ 健康检查失败，回退到 $PREV"
  git reset --hard "$PREV" --quiet
  sudo -n docker compose up -d --build 2>&1 | tail -1
  echo "[$(date '+%F %T')] 已回退并重启"
fi
