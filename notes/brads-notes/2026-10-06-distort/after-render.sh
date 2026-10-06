#!/bin/zsh
cd "$(dirname "$0")"
while pgrep -f render-1k.sh > /dev/null; do sleep 30; done
./variant.sh -ds & ./variant.sh -k2 --k1 -0.02 --interp cubic & ./variant.sh -k8 --k1 -0.08 --interp cubic & wait
echo "variants finished"
