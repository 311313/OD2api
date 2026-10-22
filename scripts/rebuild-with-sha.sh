#!/bin/bash
cd ~/opendesign2api
echo "=== 手动带 args 构建 ==="
export GIT_SHA="$(git rev-parse HEAD)"
export BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  GIT_SHA=$GIT_SHA"
echo "  BUILD_TIME=$BUILD_TIME"

sudo -n -E docker compose build --no-cache 2>&1 | tail -8

echo ""
echo "=== 用新镜像重建容器 ==="
sudo -n -E docker compose up -d 2>&1 | tail -3

sleep 8
echo ""
echo "=== 容器内环境 ==="
sudo -n docker exec opendesign2api sh -c 'env | grep -E "GIT_SHA|BUILD_TIME"'

echo ""
echo "=== /version ==="
sleep 3
T=$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2)
curl -s --max-time 10 -H "x-admin-token: $T" http://127.0.0.1:7890/api/admin/version | head -c 300
echo ""
