#!/bin/bash
cd ~/opendesign2api || exit 1

echo "════════ 部署前兼容性检查 ════════"

echo ""
echo "1. .env 关键变量"
grep -E '^(UPSTREAM_NETWORK|ADMIN_TOKEN|GATEWAY_API_KEY)=' .env 2>/dev/null | \
  sed 's/\(=.\{8\}\).*/\1…/' | sed 's/^/   /'

echo ""
echo "2. 容器当前网络"
sudo -n docker inspect opendesign2api --format '{{range $k, $v := .NetworkSettings.Networks}}   {{$k}}  {{$v.IPAddress}}{{"\n"}}{{end}}'

echo ""
echo "3. docker 网络是否存在"
for n in deploy_sub2api-network opendesign2api_default od2api-upstream; do
  if sudo -n docker network ls --format '{{.Name}}' | grep -qx "$n"; then
    echo "   ✓ $n"
  else
    echo "   ✗ $n 不存在"
  fi
done

echo ""
echo "4. git 远端能否访问（cron 用户）"
if git ls-remote origin main >/dev/null 2>&1; then
  echo "   ✓ 可访问，远端 HEAD: $(git ls-remote origin main | cut -c1-7)"
else
  echo "   ✗ 无法访问（凭据问题？）"
fi

echo ""
echo "5. 当前分支"
echo "   $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"

echo ""
echo "6. 脚本语法自检（当前版本）"
if bash -n scripts/auto-update.sh 2>/dev/null; then
  echo "   ✓ 当前脚本语法 OK"
else
  echo "   ✗ 当前脚本有语法错误"
  bash -n scripts/auto-update.sh 2>&1 | head -3 | sed 's/^/     /'
fi

echo ""
echo "════════ 结论 ════════"
ENV_NET=$(grep '^UPSTREAM_NETWORK=' .env 2>/dev/null | cut -d= -f2)
if [ -n "$ENV_NET" ] && sudo -n docker network ls --format '{{.Name}}' | grep -qx "$ENV_NET"; then
  echo "   ✓ .env 的 UPSTREAM_NETWORK=$ENV_NET 存在，重建后网络不会丢"
else
  echo "   ⚠ UPSTREAM_NETWORK 未设置或网络不存在，重建后容器将只挂 default 网络"
fi
