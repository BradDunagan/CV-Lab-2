#!/bin/zsh
# Re-analyse stack-2g runs as 2026-10-05-repeat/pool.sh does, with extra
# gap-sweep options: EXTRA="--ledge-fit" or EXTRA="--ledge <file>".
# SUFFIX=-blur analyses the degraded copies, pooled from their own sweeps.
#   pool.sh x y z turn test test-r2 test-r3 test-low
cd "$(dirname "$0")/../../.."
POOL=(--carry-from results/stack-2g-x$SUFFIX/pairs --carry-from results/stack-2g-y$SUFFIX/pairs --carry-from results/stack-2g-z$SUFFIX/pairs --carry-from results/stack-2g-turn$SUFFIX/pairs)
COMMON=(--scene saved:stack-2 --moving Cube2 --target Cube --yaw 35,60 --elevation 20,50 --script pipelines/pairs.lab --carry --skip-render $POOL ${=EXTRA})
TEST="1.5,5,-1,0;-2,3,2,0;0.7,6,1.3,0;-1.2,4.5,-2.5,0;2.5,2.5,0.8,0;1,4,-1,1.5;-1.5,5,1.5,-2;0.5,3,-0.5,2.5;-0.8,6,2.2,-1;2,4.5,0,-3"
LOW="1.5,1.5,-1,0;-2,1,2,0;0.7,2,1.3,1;-1.2,0.8,-2.5,-1;2.5,1.2,0.8,2;1,0.6,-1,-2;-1.5,2.5,1.5,1.5;0.5,1,-0.5,-2.5"
for r in "$@"; do
  case $r in
    x) A=(--axis 1,0,0 --offset 0,4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    y) A=(--axis 0,1,0 --offset 0,4,0 --gaps -2,-1,0,1,2,4) ;;
    z) A=(--axis 0,0,1 --offset 0,4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    turn) A=(--poses "0,4,0,-3;0,4,0,-1.5;0,4,0,0;0,4,0,1.5;0,4,0,3") ;;
    test-low) A=(--poses "$LOW") ;;
    test*) A=(--poses "$TEST") ;;
  esac
  name=stack-2g-$r$SUFFIX
  npm run -s gap-sweep -- --name $name $COMMON $A > /tmp/ledge-pool-$r$SUFFIX.log 2>&1 && echo "done $r$SUFFIX" || echo "FAIL $r$SUFFIX"
done
