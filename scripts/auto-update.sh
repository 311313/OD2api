#!/usr/bin/env bash
# opendesign2api 自动更新 + 面板一键更新。
#
# 触发方式：
#   1. cron 每分钟检查 —— 有 ./data/.update-request 立即执行；否则每 5 分钟查一次远端
#   2. 面板点"更新" —— 写触发文件，cron 下一分钟接手
#
# cron: */1 * * * * bash ~/opendesign2api/scripts/auto-update.sh >> ~/opendesign2api/auto-update.log 2>&1
#
# 安全设计：
#   - 只有 src/ public/ Dockerfile compose 有变更才重建
#   - 构建失败或健康检查失败都回退到上一版并重建
#   - 健康检查必须确认版本号已变成目标 commit，防止"旧容器还活着"被误判成功
set -uo pipefail

APP="${OD2API_DIR:-$HOME/opendesign2api}"
cd "$APP" || exit 1
LOCK=/tmp/od2api-update.lock
TRIGGER="$APP/data/.update-request"
STAMP="$APP/.last-fetch"

exec 9>"$LOCK"
flock -n 9 || exit 0

FORCED=0
if [ -f "$TRIGGER" ]; then
  FORCED=1
  echo "[$(date '+%F %T')] 面板请求更新"
  rm -f "$TRIGGER"
fi

if [ "$FORCED" = 0 ]; then
  NOW=$(date +%s)
  LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
  [ $((NOW - LAST)) -lt 270 ] && exit 0
fi
date +%s > "$STAMP"

git fetch origin main --quiet 2>/dev/null || {
  echo "[$(date '+%F %T')] fetch 失败（网络？）"
  exit 1
}

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  [ "$FORCED" = 1 ] && echo "[$(date '+%F %T')] 已是最新 $(git rev-parse --short HEAD)"
  exit 0
fi

echo "[$(date '+%F %T')] 有更新: $(git rev-parse --short "$LOCAL") → $(git rev-parse --short "$REMOTE")"
PREV="$LOCAL"

CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE" -- src/ public/ Dockerfile docker-compose.yml | head -1)
git reset --hard origin/main --quiet

if [ -z "$CHANGED" ]; then
  echo "[$(date '+%F %T')] 仅文档/脚本变更，已拉取，无需重建"
  exit 0
fi

# ── 重建 ──
export GIT_SHA="$REMOTE"
export BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# compose 里的 ${UPSTREAM_NETWORK:-dummy} 需要一个存在的网络名；
# 服务器上没有额外网络时给空值，让 compose 跳过该挂载
export UPSTREAM_NETWORK="${UPSTREAM_NETWORK:-}"

echo "[$(date '+%F %T')] 重建容器 (${GIT_SHA:0:7})…"
if ! sudo -n -E docker compose up -d --build 2>&1 | tail -3; then
  echo "[$(date '+%F %T')] ✗ 构建命令失败，回退"
  git reset --hard "$PREV" --quiet
  exit 1
fi

# ── 校验：容器必须真的跑着新版本 ──
OK=0
for i in $(seq 1 12); do
  sleep 5
  # 容器内环境变量是构建注入的，直接问它比问 /health 更能证明"重建生效了"
  SHA=$(sudo -n docker exec opendesign2api printenv GIT_SHA 2>/dev/null | tr -d '\r')
  H=$(sudo -n docker exec opendesign2api node -e '
    fetch("http://127.0.0.1:7890/health").then(r=>r.json()).then(j=>{
      console.log(j.ok?"OK":"BAD");
    }).catch(()=>console.log("BAD"));
  ' 2>/dev/null | tail -1)
  if [ "$H" = "OK" ] && [ "$SHA" = "$REMOTE" ]; then OK=1; break; fi
done

if [ "$OK" = 1 ]; then
  echo "[$(date '+%F %T')] ✓ 更新完成 ${REMOTE:0:7}（版本号已确认）"
  rm -f /tmp/od.tar.gz
else
  echo "[$(date '+%F %T')] ✗ 校验失败（期望 $REMOTE，实际 ${SHA:-空}），回退到 ${PREV:0:7}"
  git reset --hard "$PREV" --quiet
  export GIT_SHA="$PREV"
  sudo -n -E docker compose up -d --build 2>&1 | tail -2
  echo "[$(date '+%F %T')] 已回退"
fi
