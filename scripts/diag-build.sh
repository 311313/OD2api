#!/bin/bash
cd ~/opendesign2api

echo "=== compose 的 build args 配置 ==="
grep -A6 "build:" docker-compose.yml | sed 's/^/  /'

echo ""
echo "=== 手动构建测试：检查 sudo -E 是否传环境变量 ==="
echo -n "  当前 shell GIT_SHA="
echo "${GIT_SHA:-(未设置)}"

echo ""
echo "=== docker-compose 解析后的 build args ==="
export GIT_SHA="testsha1234567890"
export BUILD_TIME="2026-01-01T00:00:00Z"
sudo -n -E docker compose config 2>/dev/null | grep -A4 "args:" | head -8 | sed 's/^/  /'

echo ""
echo "=== 容器内实际环境 ==="
sudo -n docker exec opendesign2api sh -c 'env | grep -E "GIT_SHA|BUILD_TIME" || echo "  (无)"'

echo ""
echo "=== 镜像构建历史（看 ARG 是否注入）==="
sudo -n docker history opendesign2api:latest --no-trunc --format '{{.CreatedBy}}' 2>/dev/null | grep -iE "GIT_SHA|ARG" | head -3 | sed 's/^/  /'
