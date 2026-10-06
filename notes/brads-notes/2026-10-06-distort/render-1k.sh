#!/bin/zsh
# The stack-2 sweeps and test poses rendered at 1024 px, the source for
# distortion without resampling blur: degrade.js --downsample 2 (Catmull-Rom
# at 1024, then 2x2 averaged to 512).
cd "$(dirname "$0")/../../.."
COMMON=(--scene saved:stack-2 --moving Cube2 --target Cube --yaw 35,60 --elevation 20,50 --size 1024)
TEST="1.5,5,-1,0;-2,3,2,0;0.7,6,1.3,0;-1.2,4.5,-2.5,0;2.5,2.5,0.8,0;1,4,-1,1.5;-1.5,5,1.5,-2;0.5,3,-0.5,2.5;-0.8,6,2.2,-1;2,4.5,0,-3"
for r in x y z turn test; do
  case $r in
    x) A=(--axis 1,0,0 --offset 0,4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    y) A=(--axis 0,1,0 --offset 0,4,0 --gaps -2,-1,0,1,2,4) ;;
    z) A=(--axis 0,0,1 --offset 0,4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    turn) A=(--poses "0,4,0,-3;0,4,0,-1.5;0,4,0,0;0,4,0,1.5;0,4,0,3") ;;
    test) A=(--poses "$TEST") ;;
  esac
  npm run -s gap-sweep -- --name stack-2g-$r-1k $COMMON $A > /tmp/render-1k-$r.log 2>&1 && echo "rendered $r" || echo "FAIL $r"
done
