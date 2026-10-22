#!/bin/bash
cd ~/opendesign2api

# 补写标记：当前 HEAD 就是已部署代码
git rev-parse HEAD > data/.deployed-sha
echo "=== 标记已写 ==="
echo "  值: $(cat data/.deployed-sha)"

# 让容器内的 node 也能读到（文件在挂载目录里，天然共享）
ls -la data/.deployed-sha | sed 's/^/  /'

echo ""
echo "=== /version 验证 ==="
T=$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2)
curl -s --max-time 15 -H "x-admin-token: $T" "http://127.0.0.1:7890/api/admin/version?check=1" | \
  python3 -c '
import sys, json
d = json.load(sys.stdin)
print("  镜像版本:", d.get("shortSha"))
print("  部署代码:", d.get("deployedShort"))
print("  远端最新:", (d.get("latest") or {}).get("shortSha") or (d.get("latest") or {}).get("error"))
print("  已最新:  ", d.get("upToDate"))
print("  待重建:  ", d.get("needsRebuild"))
' 2>/dev/null

echo ""
echo "=== 再跑一次 auto-update 确认标记不会被清掉 ==="
bash scripts/auto-update.sh 2>&1 | sed 's/^/  /'
echo "  标记仍为: $(cat data/.deployed-sha 2>/dev/null || echo '(丢失)')"
