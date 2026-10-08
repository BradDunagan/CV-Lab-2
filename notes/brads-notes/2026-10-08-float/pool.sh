#!/bin/zsh
# 2026-10-05-repeat/pool.sh, with two switches for float frames:
#   RENDER=1  render the run (no --skip-render)
#   FLOAT=1   read each shot's .pfm with frame(); results go to .../pairs/float
# SUFFIX=-f pool.sh x ... analyses stack-2g-x-f and so on, pooled from the
# sweeps with the same suffix and the same kind of frame.
cd "$(dirname "$0")/../../.."
FD=; [[ -n $FLOAT ]] && FD=/float
POOL=(--carry-from results/stack-2g-x$SUFFIX/pairs$FD --carry-from results/stack-2g-y$SUFFIX/pairs$FD --carry-from results/stack-2g-z$SUFFIX/pairs$FD --carry-from results/stack-2g-turn$SUFFIX/pairs$FD)
[[ -n $NOPOOL ]] && POOL=()
SKIP=(--skip-render); [[ -n $RENDER ]] && SKIP=()
FL=(); [[ -n $FLOAT ]] && FL=(--float)
COMMON=(--scene saved:stack-2 --moving Cube2 --target Cube --yaw 35,60 --elevation 20,50 --script pipelines/pairs.lab --carry $SKIP $POOL $FL)
TEST="1.5,5,-1,0;-2,3,2,0;0.7,6,1.3,0;-1.2,4.5,-2.5,0;2.5,2.5,0.8,0;1,4,-1,1.5;-1.5,5,1.5,-2;0.5,3,-0.5,2.5;-0.8,6,2.2,-1;2,4.5,0,-3"
for r in "$@"; do
  case $r in
    x) A=(--axis 1,0,0 --offset 0,4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    y) A=(--axis 0,1,0 --offset 0,4,0 --gaps -2,-1,0,1,2,4) ;;
    z) A=(--axis 0,0,1 --offset 0,4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    turn) A=(--poses "0,4,0,-3;0,4,0,-1.5;0,4,0,0;0,4,0,1.5;0,4,0,3") ;;
    test*) A=(--poses "$TEST") ;;
  esac
  name=stack-2g-$r$SUFFIX
  log=results/float/logs/$r$SUFFIX${FLOAT:+-float}${RENDER:+-render}.log
  mkdir -p ${log:h}
  npm run -s gap-sweep -- --name $name $COMMON $A > $log 2>&1 && echo "done $r$SUFFIX${FLOAT:+ float}" || echo "FAIL $r$SUFFIX (see $log)"
done
