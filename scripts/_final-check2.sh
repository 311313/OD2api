#!/bin/bash
# 生产终检：健康、令牌机制、面板可达
sleep 12
echo "=== 容器 ==="
sudo -n docker ps --filter name=opendesign2api --format '  {{.Status}}'

echo ""
echo "=== 令牌机制（用 .env 里的令牌）==="
T=$(grep '^ADMIN_TOKEN=' ~/opendesign2api/.env | cut -d= -f2)
R=$(curl -s -H "x-admin-token: $T" http://127.0.0.1:7890/api/admin/token)
echo "  /token: ${R:0:60}…"

echo ""
echo "=== no-store 头确认 ==="
curl -s -D - -o /dev/null -H "x-admin-token: $T" http://127.0.0.1:7890/api/admin/token 2>/dev/null | grep -i "cache-control" | head -1 | sed 's/^/  /'

echo ""
echo "=== 启动日志无明文令牌 ==="
C=$(sudo -n docker logs opendesign2api 2>&1 | grep -c "xlsw03d1\|已生成随机管理令牌（首次启动）：" || true)
echo "  明文令牌出现次数: $C"

echo ""
echo "=== 无鉴权访问 401 ==="
R2=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7890/api/admin/accounts)
echo "  无令牌: $R2"
