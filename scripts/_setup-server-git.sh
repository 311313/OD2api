#!/bin/bash
# 服务器端安装：git 化 + 首次 pull + cron
set -e

APP=~/opendesign2api
cd "$APP"

echo "=== 1. 当前部署转 git 仓库 ==="
if [ ! -d .git ]; then
  git init -q
  git remote add origin https://github.com/311313/OD2api.git
  echo "  git 已初始化"
else
  echo "  已是 git 仓库"
fi

echo ""
echo "=== 2. 保护现场文件（data/.env/backups 不能被覆盖）==="
# 这些在 .gitignore 里，pull 不会碰它们；确认
grep -q '^data/' .gitignore 2>/dev/null || echo "  ⚠ .gitignore 缺 data/"
ls .gitignore >/dev/null && echo "  .gitignore 就位"

echo ""
echo "=== 3. 首次 fetch + 对齐 ==="
git fetch origin main 2>&1 | tail -1 || { echo "fetch 失败"; exit 1; }
LOCAL=$(git rev-parse HEAD 2>/dev/null || echo "none")
REMOTE=$(git rev-parse origin/main)
echo "  本地: $LOCAL"
echo "  远端: $REMOTE"

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "  对齐到远端…"
  git reset --hard origin/main --quiet
  sudo -n chown -R 1000:1000 src public 2>/dev/null || true
  echo "  已对齐 $REMOTE"
fi

echo ""
echo "=== 4. 安装 auto-update.sh ==="
# 脚本本身从仓库来，但当前版本先直接写入
echo "  （脚本随仓库分发）"
chmod +x scripts/auto-update.sh 2>/dev/null || true

echo ""
echo "=== 5. 装 cron（每 5 分钟）==="
# 去掉旧条目再加，防重复
(crontab -l 2>/dev/null | grep -v auto-update.sh; echo '*/5 * * * * bash '$HOME'/opendesign2api/scripts/auto-update.sh >> '$HOME'/opendesign2api/auto-update.log 2>&1') | crontab -
crontab -l | grep -E "auto-update|backup" | sed 's/^/  /'

echo ""
echo "=== 6. 手动跑一次验证 ==="
bash scripts/auto-update.sh
echo "  exit=$?"
echo "  日志: $(tail -2 auto-update.log 2>/dev/null || echo '(无更新输出 = 正常)')"

echo ""
echo "=== 7. 服务健康 ==="
sudo -n docker ps --filter name=opendesign2api --format '  {{.Status}}'
