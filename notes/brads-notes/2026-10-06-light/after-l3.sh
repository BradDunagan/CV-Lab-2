#!/bin/zsh
# GPU queue, part three: two lights bracketing stack-2's, then the repeat sweeps.
cd "$(dirname "$0")"
sleep 10
while pgrep -f "after-tip.sh" > /dev/null; do sleep 30; done
for l in l4 l5; do ./light.sh stack-$l stack-${l}g || echo "FAIL $l"; done
../2026-10-06-repeat/sweeps-r2.sh
