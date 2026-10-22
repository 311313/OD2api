#!/usr/bin/env bash
# opendesign2api 自动更新 + 面板一键更新。
#
# 两种触发方式：
#   1. cron 定时（默认每 5 分钟）—— 有远端新提交就更新
#   2. 面板点"更新"—— 写 ./data/.update-request，cron 每分钟见到就立即执行
#
# cron:
#   */1 * * * * bash ~/opendesign2api/scripts/auto-update.sh >> ~/opendesign2api/auto-update.log 2>&1
#   # 内部再判断：有触发文件随时跑；否则每 5 分钟才查一次远端
#
# 安全设计：
#   - 只有 src/ 或 public/ 有实际变更才重建（文档变更不折腾容器）
#   - 健康检查 60s 不过就回退并重启
#   - 数据库在 ./data（gitignored），pull 不会碰数据
#   - 触发文件处理完立即删除，避免重复触发
set -uo pipefail

APP="${OD2API_DIR:-$HOME/opendesign2api}"
cd "$APP" || exit 1
LOCK=/tmp/od2api-update.lock
TRIGGER="$APP/data/.update-request"
STAMP="$APP/.last-fetch"          # 上次查远端的时间戳（秒）

# 防并发：上一轮还没跑完就跳过
exec 9>"$LOCK"
flock -n 9 || exit 0

FORCED=0
if [ -f "$TRIGGER" ]; then
  FORCED=1
  echo "[$(date '+%F %T')] 面板请求更新"
  rm -f "$TRIGGER"
fi

# 非强制时，每 5 分钟才查一次远端，省得每分钟打 GitHub
if [ "$FORCED" = 0 ]; then
  NOW=$(date +%s)
  LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
  if [ $((NOW - LAST)) -lt 270 ]; then
    exit 0
  fi
fi
date +%s > "$STAMP"

git fetch origin main --quiet 2>/dev/null || {
  echo "[$(date '+%F %T')] fetch 失败（网络？）"
  exit 1
}

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  [ "$FORCED" = 1 ] && echo "[$(date '+%F %T')] 已是最新 ($(git rev-parse --short HEAD))，无需更新"
  exit 0
fi

echo "[$(date '+%F %T')] 有更新: $(git rev-parse --short "$LOCAL") → $(git rev-parse --short "$REMOTE")"
PREV="$LOCAL"

# src/public 是否变更（决定要不要重建容器）
CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE" -- src/ public/ Dockerfile docker-compose.yml | head -1)

git reset --hard origin/main --quiet

if [ -z "$CHANGED" ]; then
  echo "[$(date '+%F %T')] 仅文档/脚本变更，已拉取，无需重建"
  exit 0
fi

# 构建时把 commit 注入镜像，面板据此显示版本
export GIT_SHA="$REMOTE"
export BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "[$(date '+%F %T')] src/public 有变更，重建容器…"
sudo -n docker compose up -d --build 2>&1 | tail -2

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
  echo "[$(date '+%F %T')] ✓ 更新完成，健康检查通过 ($(git rev-parse --short HEAD))"
  rm -f /tmp/od.tar.gz
else
  echo "[$(date '+%F %T')] ✗ 健康检查失败，回退到 $(git rev-parse --short "$PREV")"
  git reset --hard "$PREV" --quiet
  export GIT_SHA="$PREV"
  sudo -n docker compose up -d --build 2>&1 | tail -1
  echo "[$(date '+%F %T')] 已回退并重启"
fi
