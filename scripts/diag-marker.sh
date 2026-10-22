#!/bin/bash
cd ~/opendesign2api
echo "=== .deployed-sha 内容 ==="
ls -la data/.deployed-sha 2>/dev/null || echo "  文件不存在"
echo "  值: [$(cat data/.deployed-sha 2>/dev/null)]"

echo ""
echo "=== auto-update.sh 里写标记的行 ==="
grep -n "deployed-sha" scripts/auto-update.sh | sed 's/^/  /'

echo ""
echo "=== 当前 HEAD ==="
git rev-parse HEAD
