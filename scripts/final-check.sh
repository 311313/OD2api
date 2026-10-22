#!/bin/bash
cd ~/opendesign2api

echo "=== 等自动更新完成（最多 6 分钟）==="
for i in $(seq 1 36); do
  sleep 10
  REMOTE=$(git ls-remote origin main 2>/dev/null | cut -f1)
  LOCAL=$(git rev-parse HEAD)
  SHA=$(sudo -n docker exec opendesign2api printenv GIT_SHA 2>/dev/null | tr -d '\r')
  if [ "$LOCAL" = "$REMOTE" ] && [ "$SHA" = "$REMOTE" ]; then
    echo "  ✓ 第 $((i*10)) 秒：代码与镜像都是 $(echo $REMOTE | cut -c1-7)"
    break
  fi
  [ $((i % 3)) -eq 0 ] && echo "  [$((i*10))s] 本地=$(echo $LOCAL|cut -c1-7) 远端=$(echo $REMOTE|cut -c1-7) 镜像=$(echo $SHA|cut -c1-7)"
  [ $i -eq 36 ] && echo "  ⚠ 超时"
done

echo ""
echo "=== 更新日志 ==="
tail -6 auto-update.log | sed 's/^/  /'

echo ""
echo "=== 部署标记 ==="
cat data/.deployed-sha 2>/dev/null | sed 's/^/  /'
echo ""

echo ""
echo "=== /version 双版本 ==="
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
echo "=== 健康 ==="
curl -s --max-time 5 http://127.0.0.1:7890/health | sed 's/^/  /'
echo ""
