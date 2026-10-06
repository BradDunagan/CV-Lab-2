#!/bin/zsh
# Item 7a: the four calibration sweeps rendered a second time (path-tracer
# noise only), analysed with the same pooled still edge, so a calibration
# made from them can be set against the first.
cd "$(dirname "$0")/../../.."
POOL=(--carry-from results/stack-2g-x/pairs --carry-from results/stack-2g-y/pairs --carry-from results/stack-2g-z/pairs --carry-from results/stack-2g-turn/pairs)
COMMON=(--scene saved:stack-2 --moving Cube2 --target Cube --yaw 35,60 --elevation 20,50 --script pipelines/pairs.lab --carry $POOL)
for r in x y z turn; do
  case $r in
    x) A=(--axis 1,0,0 --offset 0,4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    y) A=(--axis 0,1,0 --offset 0,4,0 --gaps -2,-1,0,1,2,4) ;;
    z) A=(--axis 0,0,1 --offset 0,4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    turn) A=(--poses "0,4,0,-3;0,4,0,-1.5;0,4,0,0;0,4,0,1.5;0,4,0,3") ;;
  esac
  npm run -s gap-sweep -- --name stack-2g-$r-r2 $COMMON $A > /tmp/r2-$r.log 2>&1 && echo "done $r" || echo "FAIL $r"
done
