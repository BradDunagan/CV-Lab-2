#!/bin/zsh
# Tipping: the top cube rotated about the horizontal axes, which was never
# rendered. A sweep of tips about x and one about z at the reference pose,
# and eight test poses mixing tips with offsets and turns. Analysed as the
# stack-2g sweeps are (pooled still edge, --carry).
#   tip.sh [--skip-render]
cd "$(dirname "$0")/../../.."
POOL=(--carry-from results/stack-2g-x/pairs --carry-from results/stack-2g-y/pairs --carry-from results/stack-2g-z/pairs --carry-from results/stack-2g-turn/pairs)
COMMON=(--scene saved:stack-2 --moving Cube2 --target Cube --yaw 35,60 --elevation 20,50 --script pipelines/pairs.lab --carry --max-angle 12 $POOL "$@")
TEST="1,4.5,-1,0,1,0;-1.5,4,1,0,0,-1;0.5,5,0.5,1,-1,1;-1,3.5,-0.5,-1,1.5,0;1.5,4,1,0.5,0,1.5;0,5,-1,-1.5,-1,-1;-0.5,4.5,1.5,0,-1.5,0.5;1,3.5,0,2,0.5,-1.5"
for r in tipx tipz test-tip; do
  case $r in
    tipx) A=(--poses "0,4,0,0,-2,0;0,4,0,0,-1,0;0,4,0,0,0,0;0,4,0,0,1,0;0,4,0,0,2,0") ;;
    tipz) A=(--poses "0,4,0,0,0,-2;0,4,0,0,0,-1;0,4,0,0,0,0;0,4,0,0,0,1;0,4,0,0,0,2") ;;
    test-tip) A=(--poses "$TEST") ;;
  esac
  npm run -s gap-sweep -- --name stack-2g-$r $COMMON $A > /tmp/tip-$r.log 2>&1 && echo "done $r" || echo "FAIL $r"
done
