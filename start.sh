#!/usr/bin/env bash
# 启动配置台（macOS / Linux）。Ctrl+C 停止。
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没找到 Node.js，请先安装 Node 20+：https://nodejs.org/" >&2
  exit 1
fi

echo "使用 Node $(node -v)"

if [ ! -f config.json ] && [ -f config.example.json ]; then
  cp config.example.json config.json
  echo "[提示] 已根据 config.example.json 生成 config.json（按需修改里面的路径）"
fi

exec node src/server.mjs --open
