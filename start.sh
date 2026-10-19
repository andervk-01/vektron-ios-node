#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if pgrep -f "node.*server\.js" >/dev/null 2>&1; then
  echo "[VektronNode] server.js already running."
  exit 0
fi

nohup node "$DIR/server.js" > /tmp/vektron-node.log 2>&1 &
echo "[VektronNode] Started server.js daemon (PID $!)."
