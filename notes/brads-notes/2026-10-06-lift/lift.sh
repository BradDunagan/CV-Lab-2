#!/bin/zsh
# The x, z and turn sweeps again at a second lift (1.5 mm instead of 4), for a
# Jacobian that depends on the lift, and eight test poses 0.6 to 2.5 mm up. Rendered, then analysed as the stack-2g
# sweeps are: --carry with the pooled still edge.
#   lift.sh [--skip-render]
cd "$(dirname "$0")/../../.."
L=${LIFT:-1.5}
POOL=(--carry-from results/stack-2g-x/pairs --carry-from results/stack-2g-y/pairs --carry-from results/stack-2g-z/pairs --carry-from results/stack-2g-turn/pairs)
COMMON=(--scene saved:stack-2 --moving Cube2 --target Cube --yaw 35,60 --elevation 20,50 --script pipelines/pairs.lab --carry $POOL "$@")
LOW="1.5,1.5,-1,0;-2,1,2,0;0.7,2,1.3,1;-1.2,0.8,-2.5,-1;2.5,1.2,0.8,2;1,0.6,-1,-2;-1.5,2.5,1.5,1.5;0.5,1,-0.5,-2.5"
for r in x z turn test-low; do
  case $r in
    x) A=(--axis 1,0,0 --offset 0,$L,0 --gaps -4,-2,-1,0,1,2,4) ;;
    z) A=(--axis 0,0,1 --offset 0,$L,0 --gaps -4,-2,-1,0,1,2,4) ;;
    turn) A=(--poses "0,$L,0,-3;0,$L,0,-1.5;0,$L,0,0;0,$L,0,1.5;0,$L,0,3") ;;
    test-low) A=(--poses "$LOW") ;;
  esac
  name=stack-2g-$r-lift$L; [[ $r == test-low ]] && name=stack-2g-test-low
  npm run -s gap-sweep -- --name $name $COMMON $A > /tmp/lift-$r.log 2>&1 && echo "done $r" || echo "FAIL $r"
done
