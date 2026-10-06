#!/bin/zsh
cd "$(dirname "$0")"
while pgrep -f render-1k.sh > /dev/null; do sleep 30; done
./variant.sh -k30 --k1 -0.3 --interp cubic && echo "k30 finished"
