#!/bin/zsh
# Open item B, analysed: the moving part below (render.sh), each run re-read
# with the still edge pooled from the four sweeps, as stack-2g's are.
#   analyse.sh <stage> <run> ...
#   stage: base (no ledge), fit (--ledge-fit), ledge (--ledge results/ledge/stack-2b-ledge.json)
# Runs in the worktree holding the code being measured (CODE, default ../cv-lab-2-below),
# results and generated linked there.
CODE=${CODE:-/Users/bradsmac/dev/ai/cv-lab-2-below}
cd $CODE
stage=$1; shift
case $stage in
  base) EXTRA=() ;;
  fit) EXTRA=(--ledge-fit) ;;
  ledge) EXTRA=(--ledge results/ledge/stack-2b-ledge.json) ;;
esac
POOL=(--carry-from results/stack-2b-x/pairs --carry-from results/stack-2b-y/pairs --carry-from results/stack-2b-z/pairs --carry-from results/stack-2b-turn/pairs)
COMMON=(--scene saved:stack-2 --moving Cube --target Cube2 --yaw 35,60 --elevation 20,50 --script pipelines/pairs.lab --carry --skip-render $POOL $EXTRA)
neg() { echo "$1" | awk -F';' '{for(i=1;i<=NF;i++){split($i,v,",");printf "%s%g,%g,%g,%g",(i>1?";":""),-v[1],-v[2],-v[3],-v[4]}}'; }
TEST=$(neg "1.5,5,-1,0;-2,3,2,0;0.7,6,1.3,0;-1.2,4.5,-2.5,0;2.5,2.5,0.8,0;1,4,-1,1.5;-1.5,5,1.5,-2;0.5,3,-0.5,2.5;-0.8,6,2.2,-1;2,4.5,0,-3")
LOW=$(neg "1.5,1.5,-1,0;-2,1,2,0;0.7,2,1.3,1;-1.2,0.8,-2.5,-1;2.5,1.2,0.8,2;1,0.6,-1,-2;-1.5,2.5,1.5,1.5;0.5,1,-0.5,-2.5")
for r in "$@"; do
  case $r in
    x) A=(--axis -1,0,0 --offset 0,-4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    y) A=(--axis 0,-1,0 --offset 0,-4,0 --gaps -2,-1,0,1,2,4) ;;
    z) A=(--axis 0,0,-1 --offset 0,-4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    turn) A=(--poses "0,-4,0,3;0,-4,0,1.5;0,-4,0,0;0,-4,0,-1.5;0,-4,0,-3") ;;
    test) A=(--poses "$TEST") ;;
    test-low) A=(--poses "$LOW") ;;
  esac
  npm run -s gap-sweep -- --name stack-2b-$r $COMMON $A > /Users/bradsmac/dev/ai/cv-lab-2/notes/brads-notes/2026-10-07-below/$stage-$r.log 2>&1 && echo "$stage $r" || echo "FAIL $stage $r"
  # Keep each stage's reading of the run beside the live one.
  rm -rf results/stack-2b-$r-$stage && cp -R results/stack-2b-$r/pairs results/stack-2b-$r-$stage-tmp && mkdir -p results/stack-2b-$r-$stage && mv results/stack-2b-$r-$stage-tmp results/stack-2b-$r-$stage/pairs
done
