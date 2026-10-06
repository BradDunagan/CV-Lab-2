#!/bin/zsh
# One light, scored as a light search scores it: the stack-2 sweeps and test
# poses under scenes/<scene>.json, analysed with that light's own pooled
# still edge, solved with no truth (hinged); its calibration RMS and test
# error are what choose a light.
#   light.sh <scene> <prefix> [--skip-render]     e.g. light.sh stack-3 stack-3g --skip-render
set -e
cd "$(dirname "$0")/../../.."
scene=$1; pre=$2; shift 2
TEST="1.5,5,-1,0;-2,3,2,0;0.7,6,1.3,0;-1.2,4.5,-2.5,0;2.5,2.5,0.8,0;1,4,-1,1.5;-1.5,5,1.5,-2;0.5,3,-0.5,2.5;-0.8,6,2.2,-1;2,4.5,0,-3"
args() {
  case $1 in
    x) A=(--axis 1,0,0 --offset 0,4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    y) A=(--axis 0,1,0 --offset 0,4,0 --gaps -2,-1,0,1,2,4) ;;
    z) A=(--axis 0,0,1 --offset 0,4,0 --gaps -4,-2,-1,0,1,2,4) ;;
    turn) A=(--poses "0,4,0,-3;0,4,0,-1.5;0,4,0,0;0,4,0,1.5;0,4,0,3") ;;
    test) A=(--poses "$TEST") ;;
  esac
}
COMMON=(--scene saved:$scene --moving Cube2 --target Cube --yaw 35,60 --elevation 20,50 --script pipelines/pairs.lab --carry)
POOL=(--carry-from results/$pre-x/pairs --carry-from results/$pre-y/pairs --carry-from results/$pre-z/pairs --carry-from results/$pre-turn/pairs)
# First pass: each sweep from its own frames (renders them too, unless --skip-render).
for r in x y z turn; do args $r; npm run -s gap-sweep -- --name $pre-$r $COMMON "$@" $A > /tmp/light-$pre-$r.log 2>&1; done
[[ " $* " == *" --skip-render "* ]] || { args test; npm run -s gap-sweep -- --name $pre-test $COMMON $A > /tmp/light-$pre-test.log 2>&1; }
# Then all of them from the pooled still edge.
for r in x y z turn test; do args $r; npm run -s gap-sweep -- --name $pre-$r $COMMON --skip-render $POOL $A > /tmp/light-$pre-$r.log 2>&1; done
mkdir -p results/light
SW=(--x results/$pre-x/pairs --y results/$pre-y/pairs --z results/$pre-z/pairs --turn results/$pre-turn/pairs --test results/$pre-test/pairs --max-views 4)
npm run -s position -- $SW --calibrate hinged --out results/light/$pre-hinged.json > results/light/$pre-hinged.txt
echo "scored $pre"
