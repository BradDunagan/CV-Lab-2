#!/bin/zsh
# Open item B: the moving part BELOW. The same scene with the roles swapped:
# the base cube (Cube) moves, the top cube (Cube2) is still. Every sweep and
# test pose is stack-2g's mirrored -- the base 4 mm below contact, slid the
# other way -- so the pictures are the same physics, and the lit ledge is now
# the MOVING part's top face, in the still part's shadow.
#   render.sh x y z turn test test-low
cd "$(dirname "$0")/../../.."
COMMON=(--scene saved:stack-2 --moving Cube --target Cube2 --yaw 35,60 --elevation 20,50 --script pipelines/pairs.lab --carry)
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
  npm run -s gap-sweep -- --name stack-2b-$r $COMMON $A > notes/brads-notes/2026-10-07-below/render-$r.log 2>&1 && echo "done $r" || echo "FAIL $r"
done
