#!/bin/zsh
# Re-analyse a stack-2 run with the still edges from the shared pool.
# SUFFIX=-noisy pool.sh x ... analyses stack-2g-x-noisy and so on, pooled from
# the sweeps with the same suffix (a degraded copy, 2026-10-05-degrade/).
cd "$(dirname "$0")/../../.."
POOL=(--carry-from results/stack-2g-x$SUFFIX/pairs --carry-from results/stack-2g-y$SUFFIX/pairs --carry-from results/stack-2g-z$SUFFIX/pairs --carry-from results/stack-2g-turn$SUFFIX/pairs)
# NOPOOL=1: each run's own frames, for a first pass over runs whose records
# do not exist yet.
[[ -n $NOPOOL ]] && POOL=()
COMMON=(--scene saved:stack-2 --moving Cube2 --target Cube --yaw 35,60 --elevation 20,50 --script pipelines/pairs.lab --carry --skip-render $POOL)
TEST="1.5,5,-1,0;-2,3,2,0;0.7,6,1.3,0;-1.2,4.5,-2.5,0;2.5,2.5,0.8,0;1,4,-1,1.5;-1.5,5,1.5,-2;0.5,3,-0.5,2.5;-0.8,6,2.2,-1;2,4.5,0,-3"
for r in "$@"; do
  case $r in
    x) A=(--axis 1,0,0 --offset 0,4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    y) A=(--axis 0,1,0 --offset 0,4,0 --gaps -2,-1,0,1,2,4) ;;
    z) A=(--axis 0,0,1 --offset 0,4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    approach) A=(--axis 0,1,0 --gaps 5,2,1,0.5,0) ;;
    turn) A=(--poses "0,4,0,-3;0,4,0,-1.5;0,4,0,0;0,4,0,1.5;0,4,0,3") ;;
    test*) A=(--poses "$TEST") ;;
  esac
  name=stack-2g-$r$SUFFIX
  npm run -s gap-sweep -- --name $name $COMMON $A > /tmp/pool-$r$SUFFIX.log 2>&1 && echo "done $r$SUFFIX" || echo "FAIL $r$SUFFIX"
done
