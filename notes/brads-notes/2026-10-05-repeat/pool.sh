#!/bin/zsh
# Re-analyse a stack-2 run with the still edges from the shared pool.
cd "$(dirname "$0")/../../.."
POOL=(--carry-from results/stack-2g-x/pairs --carry-from results/stack-2g-y/pairs --carry-from results/stack-2g-z/pairs --carry-from results/stack-2g-turn/pairs)
COMMON=(--scene saved:stack-2 --moving Cube2 --target Cube --yaw 35,60 --elevation 20,50 --script pipelines/pairs.lab --carry --skip-render $POOL)
TEST="1.5,5,-1,0;-2,3,2,0;0.7,6,1.3,0;-1.2,4.5,-2.5,0;2.5,2.5,0.8,0;1,4,-1,1.5;-1.5,5,1.5,-2;0.5,3,-0.5,2.5;-0.8,6,2.2,-1;2,4.5,0,-3"
for r in "$@"; do
  case $r in
    x) A=(--axis 1,0,0 --offset 0,4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    y) A=(--axis 0,1,0 --offset 0,4,0 --gaps -2,-1,0,1,2,4) ;;
    z) A=(--axis 0,0,1 --offset 0,4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    turn) A=(--poses "0,4,0,-3;0,4,0,-1.5;0,4,0,0;0,4,0,1.5;0,4,0,3") ;;
    test*) A=(--poses "$TEST") ;;
  esac
  name=stack-2g-$r; [[ $r == test ]] && name=stack-2g-test
  npm run -s gap-sweep -- --name $name $COMMON $A > /tmp/pool-$r.log 2>&1 && echo "done $r" || echo "FAIL $r"
done
