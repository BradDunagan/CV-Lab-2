#!/bin/zsh
# The GPU queue: one generator at a time (Electron's IndexedDB lock).
cd "$(dirname "$0")"
while pgrep -f render-1k.sh > /dev/null; do sleep 30; done
./lift.sh
../2026-10-06-tip/tip.sh
