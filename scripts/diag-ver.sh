#!/bin/bash
cd ~/opendesign2api
T=$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2)

echo "=== 直连容器 /version ==="
curl -s --max-time 15 -H "x-admin-token: $T" http://127.0.0.1:7890/api/admin/version
echo ""

echo ""
echo "=== 经隧道 17890 ==="
curl -s --max-time 15 -H "x-admin-token: $T" http://127.0.0.1:17890/api/admin/version 2>/dev/null || echo "  (隧道不通)"
echo ""

echo ""
echo "=== 前端 JS 是否最新 ==="
curl -s --max-time 10 http://127.0.0.1:7890/ | grep -o 'app\.js?v=[0-9]*'
echo ""

echo ""
echo "=== 容器内 version.js 是否有 deployedSha ==="
sudo -n docker exec opendesign2api sh -c 'grep -c deployedSha /app/src/version.js' 2>/dev/null

echo ""
echo "=== 容器内能否读到标记文件 ==="
sudo -n docker exec opendesign2api sh -c 'cat /app/data/.deployed-sha 2>/dev/null || echo "读不到"'
