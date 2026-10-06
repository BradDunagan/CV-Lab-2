#!/bin/zsh
cd "$(dirname "$0")"
sleep 10
while pgrep -f "after-1k.sh|render-1k.sh|after-tip.sh" > /dev/null; do sleep 30; done
./sweeps-r2.sh
