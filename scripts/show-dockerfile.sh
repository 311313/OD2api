#!/bin/bash
cd ~/opendesign2api
echo "=== Dockerfile 全文 ==="
cat -n Dockerfile | sed 's/^/  /'
