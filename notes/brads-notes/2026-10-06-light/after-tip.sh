#!/bin/zsh
# GPU queue, part two: the closed loop with the lift-aware calibration, then
# the candidate lights -- after the 1024 px, lift and tip renders.
cd "$(dirname "$0")"
sleep 5
while pgrep -f "after-1k.sh|render-1k.sh" > /dev/null; do sleep 30; done
../2026-10-06-lift/servo.sh
for l in l1 l2 l3; do ./light.sh stack-$l stack-${l}g || echo "FAIL $l"; done
