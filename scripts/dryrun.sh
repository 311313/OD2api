#!/bin/bash
cd ~/opendesign2api || exit 1

echo "════════ 模拟新脚本的分支判断 ════════"
# 复制即将部署的新脚本到临时位置测试
git show origin/main:scripts/auto-update.sh > /tmp/new-au.sh 2>/dev/null || {
  echo "  origin/main 里还没有新脚本（预期：尚未推送）"
  exit 0
}
bash -n /tmp/new-au.sh && echo "  ✓ 新脚本语法 OK" || { bash -n /tmp/new-au.sh; exit 1; }

# 只看分支判断逻辑
BRANCH=$(git rev-parse --abbrev-ref HEAD)
DEPLOY_BRANCHES="main master"
case " $DEPLOY_BRANCHES " in
  *" $BRANCH "*) echo "  ✓ 当前分支 $BRANCH 在允许列表内，会执行更新" ;;
  *) echo "  ✗ 当前分支 $BRANCH 被跳过" ;;
esac

echo ""
echo "════════ 检查 .env 是否会被 git reset 影响 ════════"
if git check-ignore -q .env; then
  echo "  ✓ .env 在 .gitignore 里，reset 不会覆盖它"
else
  echo "  ⚠ .env 未被忽略，reset --hard 可能覆盖！"
fi

echo ""
echo "════════ 检查 data 目录 ════════"
if git check-ignore -q data; then
  echo "  ✓ data/ 被忽略，数据库安全"
else
  echo "  ⚠ data/ 未被忽略！"
fi

echo ""
echo "════════ 当前 .deployed-sha ════════"
cat data/.deployed-sha 2>/dev/null | sed 's/^/  /' || echo "  (不存在)"

echo ""
echo "════════ 更新日志最近 3 行 ════════"
tail -3 auto-update.log 2>/dev/null | sed 's/^/  /'
