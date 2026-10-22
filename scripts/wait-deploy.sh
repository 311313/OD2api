#!/bin/bash
cd ~/opendesign2api
echo "=== 等自动更新 ==="
for i in $(seq 1 24); do
  git fetch origin main -q 2>/dev/null
  L=$(git rev-parse HEAD); R=$(git rev-parse origin/main)
  if [ "$L" = "$R" ]; then echo "  ✓ 已同步 $(git rev-parse --short HEAD)"; break; fi
  echo "  等待 ($i/24) 本地=$(git rev-parse --short HEAD) 远端=$(git rev-parse --short origin/main)"
  sleep 15
done

echo ""
echo "=== 更新日志 ==="
tail -8 auto-update.log 2>/dev/null | sed 's/^/  /'

echo ""
echo "=== 容器 ==="
sudo -n docker ps --filter name=opendesign2api --format '  {{.Status}}'

echo ""
echo "=== 版本注入 ==="
echo -n "  GIT_SHA="; sudo -n docker exec opendesign2api printenv GIT_SHA 2>/dev/null
echo -n "  BUILD_TIME="; sudo -n docker exec opendesign2api printenv BUILD_TIME 2>/dev/null

echo ""
echo "=== /version ==="
T=$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2)
curl -s -H "x-admin-token: $T" http://127.0.0.1:7890/api/admin/version 2>/dev/null | head -c 260
echo ""
