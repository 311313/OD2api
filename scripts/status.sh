#!/bin/bash
cd ~/opendesign2api
echo "=== auto-update 日志（最近 10 行）==="
tail -10 auto-update.log 2>/dev/null | sed 's/^/  /'

echo ""
echo "=== 容器 ==="
sudo -n docker ps -a --filter name=opendesign2api --format '  {{.Names}}  {{.Status}}'

echo ""
echo "=== 版本注入 ==="
echo -n "  GIT_SHA="
sudo -n docker exec opendesign2api printenv GIT_SHA 2>/dev/null || echo "(容器未运行)"
echo -n "  BUILD_TIME="
sudo -n docker exec opendesign2api printenv BUILD_TIME 2>/dev/null

echo ""
echo "=== /health ==="
curl -s --max-time 5 http://127.0.0.1:7890/health || echo "  无响应"

echo ""
echo "=== /version ==="
T=$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2)
curl -s --max-time 10 -H "x-admin-token: $T" http://127.0.0.1:7890/api/admin/version | head -c 280
echo ""

echo ""
echo "=== 网络 ==="
sudo -n docker inspect opendesign2api --format '{{range $k, $v := .NetworkSettings.Networks}}  {{$k}}{{println}}{{end}}' 2>/dev/null
