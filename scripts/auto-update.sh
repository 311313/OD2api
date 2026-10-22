#!/usr/bin/env bash
# opendesign2api 自动更新 + 面板一键更新。
#
# cron: */1 * * * * bash ~/opendesign2api/scripts/auto-update.sh >> ~/opendesign2api/auto-update.log 2>&1
#
# 关键点（踩过的坑）：
#   1. build args 必须通过 `sudo -n -E` 或显式 env 传递 —— cron 环境下 sudo 默认
#      清空环境，导致 GIT_SHA 变成空串，版本号永远显示 dev
#   2. 健康检查必须校验容器内的 GIT_SHA 等于目标 commit，
#      否则旧容器还活着会被误判成功
#   3. compose 的 external network 必须真实存在，不能给占位名
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
  echo "[$(date '+%F %T')] fetch 失败（网络）"
  exit 1
}

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  # 首次部署或标记丢失时补上
  [ -f "$APP/data/.deployed-sha" ] || echo "$LOCAL" > "$APP/data/.deployed-sha"
  [ "$FORCED" = 1 ] && echo "[$(date '+%F %T')] 已是最新 $(git rev-parse --short HEAD)"
  exit 0
fi

echo "[$(date '+%F %T')] 有更新: $(git rev-parse --short "$LOCAL") → $(git rev-parse --short "$REMOTE")"
PREV="$LOCAL"

CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE" -- src/ public/ Dockerfile docker-compose.yml | head -1)
git reset --hard origin/main --quiet

if [ -z "$CHANGED" ]; then
  # 代码已同步但无需重建：写部署标记，面板据此知道"没有新版本"
  echo "$REMOTE" > "$APP/data/.deployed-sha"
  echo "[$(date '+%F %T')] 仅文档/脚本变更，已拉取，无需重建"
  exit 0
fi

# ── 重建 ──
# 用 env 前缀显式传给 sudo，比 export + -E 更可靠（cron 的 sudo 会清环境）
SHA="$REMOTE"
BT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# public/ 有变更时自动 bump 前端资源版本号，防止浏览器用缓存旧 JS
if git diff --name-only "$LOCAL" "$REMOTE" -- public/ | grep -q .; then
  NEWVER=$(date +%Y%m%d%H%M)
  if sed -i "s/app\.js?v=[0-9]*/app.js?v=$NEWVER/" public/index.html 2>/dev/null; then
    echo "[$(date '+%F %T')] 前端资源版本号 → $NEWVER"
  fi
fi

echo "[$(date '+%F %T')] 重建容器 (${SHA:0:7})…"
if ! sudo -n env GIT_SHA="$SHA" BUILD_TIME="$BT" \
      docker compose up -d --build 2>&1 | tail -3; then
  echo "[$(date '+%F %T')] ✗ 构建失败，回退"
  git reset --hard "$PREV" --quiet
  exit 1
fi

# ── 校验：容器内的 SHA 必须等于目标 commit ──
OK=0
ACTUAL=""
for i in $(seq 1 12); do
  sleep 5
  ACTUAL=$(sudo -n docker exec opendesign2api printenv GIT_SHA 2>/dev/null | tr -d '\r')
  H=$(sudo -n docker exec opendesign2api node -e '
    fetch("http://127.0.0.1:7890/health").then(r=>r.json()).then(j=>{
      console.log(j.ok?"OK":"BAD");
    }).catch(()=>console.log("BAD"));
  ' 2>/dev/null | tail -1)
  if [ "$H" = "OK" ] && [ "$ACTUAL" = "$SHA" ]; then OK=1; break; fi
done

if [ "$OK" = 1 ]; then
  echo "$SHA" > "$APP/data/.deployed-sha"
  echo "[$(date '+%F %T')] ✓ 更新完成 ${SHA:0:7}（版本已验证）"
  rm -f /tmp/od.tar.gz
else
  echo "[$(date '+%F %T')] ✗ 校验失败：期望 ${SHA:0:7}，实际 ${ACTUAL:-空}，回退"
  git reset --hard "$PREV" --quiet
  sudo -n env GIT_SHA="$PREV" BUILD_TIME="$BT" \
    docker compose up -d --build 2>&1 | tail -2
  echo "[$(date '+%F %T')] 已回退到 ${PREV:0:7}"
fi
