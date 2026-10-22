#!/bin/bash
# 安装 systemd path 单元：监听 .update-request，出现即触发更新
set -uo pipefail

APP="$HOME/opendesign2api"
UNIT_DIR="$HOME/.config/systemd/user"

echo "=== 1. 准备目录 ==="
mkdir -p "$UNIT_DIR"
echo "  $UNIT_DIR"

echo ""
echo "=== 2. 安装 service 单元 ==="
cat > "$UNIT_DIR/od2api-update.service" <<'EOF'
[Unit]
Description=opendesign2api update (triggered by panel)

[Service]
Type=oneshot
WorkingDirectory=%h/opendesign2api
ExecStart=/usr/bin/env bash %h/opendesign2api/scripts/auto-update.sh
# 同一时刻只跑一个实例
ExecStartPre=-/usr/bin/flock -n /tmp/od2api-update.lock /bin/true
EOF

echo "  ✓ service"

echo ""
echo "=== 3. 安装 path 单元 ==="
cat > "$UNIT_DIR/od2api-update.path" <<EOF
[Unit]
Description=Watch panel update trigger

[Path]
# 文件一出现就触发 service
PathExists=$APP/data/.update-request
Unit=od2api-update.service

[Install]
WantedBy=default.target
EOF

echo "  ✓ path (监听 $APP/data/.update-request)"

echo ""
echo "=== 4. 启用 ==="
systemctl --user daemon-reload
systemctl --user enable --now od2api-update.path 2>&1 | sed 's/^/  /'

echo ""
echo "=== 5. 状态 ==="
systemctl --user status od2api-update.path --no-pager 2>&1 | head -12 | sed 's/^/  /'

echo ""
echo "=== 6. 确保 linger 开启（用户登出后仍运行）==="
if loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
  echo "  ✓ linger 已开启"
else
  sudo -n loginctl enable-linger "$USER" 2>/dev/null && echo "  ✓ 已开启 linger" || echo "  ⚠ 无法开启，重启后可能失效"
fi

echo ""
echo "=== 7. 实测：写触发文件，看多久响应 ==="
rm -f "$APP/data/.update-request"
START=$(date +%s%N)
echo '{"at":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","by":"install-test"}' > "$APP/data/.update-request"
for i in $(seq 1 30); do
  sleep 0.2
  if ! systemctl --user is-active --quiet od2api-update.service 2>/dev/null; then
    if [ ! -f "$APP/data/.update-request" ]; then
      END=$(date +%s%N)
      echo "  ✓ $(( (END-START)/1000000 )) ms 内被消费"
      break
    fi
  fi
  [ $i -eq 30 ] && echo "  ⚠ 6 秒内未响应"
done

echo ""
echo "=== 8. 本次执行结果 ==="
systemctl --user status od2api-update.service --no-pager 2>&1 | head -8 | sed 's/^/  /'
echo ""
echo "  最近日志:"
journalctl --user -u od2api-update.service -n 5 --no-pager 2>/dev/null | sed 's/^/    /'
