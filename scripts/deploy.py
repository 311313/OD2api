#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一键部署到生产。

用法：
    python scripts/deploy.py              # 部署代码
    python scripts/deploy.py --no-build   # 只传文件，不重建镜像

做的事：
    1. 语法检查 src/ 和 public/ 的 JS
    2. 打 tar 包
    3. scp 到服务器
    4. 解包 + 修正属主 + docker compose up -d --build
    5. 等健康检查通过才返回

前置：需要能 ssh 到服务器（密钥路径见 SSH_KEY）。
"""

import argparse
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import time

import os
# 从环境变量读：既不泄露你的路径，也不锁死你的服务器
SSH_KEY = os.environ.get('OD2API_SSH_KEY')
HOST = os.environ.get('OD2API_HOST')
if not SSH_KEY or not HOST:
    print('Set OD2API_SSH_KEY and OD2API_HOST first.')
    sys.exit(1)
REMOTE_DIR = '~/opendesign2api'

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(cmd, **kw):
    return subprocess.run(cmd, cwd=ROOT, **kw)


def check_syntax():
    """语法检查。有错就不部署，免得把线上搞挂。"""
    print('[1/5] 语法检查')
    targets = [
        'src/index.js', 'src/server.js', 'src/db.js', 'src/proxy.js',
        'src/upstream.js', 'src/config.js', 'src/pool.js', 'src/sticky.js',
        'src/model-limits.js', 'src/concurrency.js', 'src/deviceauth.js',
        'public/app.js',
    ]
    bad = []
    for t in targets:
        if not os.path.exists(os.path.join(ROOT, t)):
            continue
        r = run(['node', '--check', t], capture_output=True, text=True)
        if r.returncode != 0:
            bad.append((t, r.stderr.strip().split('\n')[0]))
            print('  ✗ %s' % t)
        else:
            print('  ✓ %s' % t)
    if bad:
        print('\n语法错误，中止部署:')
        for f, e in bad:
            print('  %s: %s' % (f, e))
        sys.exit(1)


def bump_version():
    """给静态资源换版本号，避免浏览器拿缓存。"""
    p = os.path.join(ROOT, 'public', 'index.html')
    with open(p, encoding='utf-8') as f:
        h = f.read()
    ver = time.strftime('%Y%m%d%H%M')
    h2 = re.sub(r'app\.js\?v=\d+', 'app.js?v=' + ver, h)
    if h2 != h:
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            f.write(h2)
    print('[2/5] 版本号 %s' % ver)


def pack():
    print('[3/5] 打包')
    tar = os.path.join(tempfile.gettempdir(), 'od2api-deploy.tar.gz')
    if os.path.exists(tar):
        os.remove(tar)
    with tarfile.open(tar, 'w:gz') as t:
        for d in ('src', 'public'):
            t.add(os.path.join(ROOT, d), arcname=d)
    print('  %s (%.1f KB)' % (tar, os.path.getsize(tar) / 1024))
    return tar


def upload(tar):
    print('[4/5] 上传')
    for i in range(1, 4):
        r = run(
            ['scp', '-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no',
             '-o', 'ConnectTimeout=30', tar, HOST + ':/tmp/'],
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            print('  ✓ 第 %d 次尝试成功' % i)
            return
        print('  第 %d 次失败，重试…' % i)
        time.sleep(3)
    print('  上传失败')
    sys.exit(1)


def build_and_restart(no_build):
    print('[5/5] 部署')
    inner = 'cd %s && tar -xzf /tmp/%s && sudo -n chown -R 1000:1000 src public' % (
        REMOTE_DIR, os.path.basename('/tmp/od2api-deploy.tar.gz'))
    if not no_build:
        inner += ' && sudo -n docker compose up -d --build 2>&1 | tail -3'
    r = run(
        ['ssh', '-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no',
         '-o', 'ConnectTimeout=60', HOST, inner],
        capture_output=True, text=True,
    )
    print(r.stdout.strip() or '(无输出)')
    if r.returncode != 0:
        print(r.stderr.strip())
        sys.exit(1)


def wait_healthy(timeout=90):
    """等容器起来。连不上就报错，不要假装成功。"""
    print('\n等待健康检查…')
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(4)
        r = run(
            ['ssh', '-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no',
             '-o', 'ConnectTimeout=15', HOST,
             'sudo -n docker exec opendesign2api node -e '
             '"fetch(\'http://127.0.0.1:7890/health\').then(r=>r.text()).then(console.log)" 2>/dev/null'],
            capture_output=True, text=True,
        )
        out = (r.stdout or '').strip()
        if '"ok":true' in out:
            print('  ✓ %s  (%ds)' % (out, int(time.time() - t0)))
            return True
        print('  … 还在启动')
    print('  ✗ 超时，请检查 docker logs')
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-build', action='store_true', help='只传文件不重建镜像')
    args = ap.parse_args()

    check_syntax()
    bump_version()
    tar = pack()
    upload(tar)
    build_and_restart(args.no_build)
    ok = wait_healthy()

    print('\n' + ('部署完成' if ok else '部署失败'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
