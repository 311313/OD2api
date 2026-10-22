#!/bin/bash
cd ~/opendesign2api || exit 1

echo "=== 分支与跟踪关系 ==="
echo "  当前分支: $(git rev-parse --abbrev-ref HEAD)"
echo "  上游跟踪: $(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo '(未设置)')"
echo ""
echo "=== 所有远端引用 ==="
git branch -r 2>/dev/null | sed 's/^/  /'
echo ""
echo "=== remote 配置 ==="
git remote -v | sed 's/^/  /'
echo ""
echo "=== fetch refspec ==="
git config --get-all remote.origin.fetch | sed 's/^/  /'
echo ""
echo "=== origin/main 是否可解析 ==="
if git rev-parse --verify origin/main >/dev/null 2>&1; then
  echo "  ✓ origin/main = $(git rev-parse --short origin/main)"
else
  echo "  ✗ origin/main 不存在"
fi
if git rev-parse --verify origin/master >/dev/null 2>&1; then
  echo "  ✓ origin/master = $(git rev-parse --short origin/master)"
else
  echo "  ✗ origin/master 不存在"
fi
