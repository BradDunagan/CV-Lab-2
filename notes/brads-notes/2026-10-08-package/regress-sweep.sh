#!/bin/zsh
# gap-sweep's carry plan and the ledge table moved into the vision package:
# the stack's test poses analysed before and after, once from their own frames
# and once pooled from the sweeps with a ledge table held and fitted, and every
# file compared (../2026-10-08-wasm/compare.js). regress-sweep.sh <tag>
cd "$(dirname "$0")/../../.."
tag=$1
for v in own pooled; do
  name=stack-2g-test-$v-$tag
  [[ -d generated/$name ]] || cp -Rc generated/stack-2g-test generated/$name
  rm -rf results/$name
done
TEST="1.5,5,-1,0;-2,3,2,0;0.7,6,1.3,0;-1.2,4.5,-2.5,0;2.5,2.5,0.8,0;1,4,-1,1.5;-1.5,5,1.5,-2;0.5,3,-0.5,2.5;-0.8,6,2.2,-1;2,4.5,0,-3"
COMMON=(--scene saved:stack-2 --moving Cube2 --target Cube --yaw 35,60 --elevation 20,50 --script pipelines/pairs.lab --carry --skip-render --poses "$TEST")
npm run -s gap-sweep -- --name stack-2g-test-own-$tag $COMMON > /dev/null 2>&1 && echo "own $tag" || echo "FAIL own"
npm run -s gap-sweep -- --name stack-2g-test-pooled-$tag $COMMON \
  --carry-from results/stack-2g-x/pairs --carry-from results/stack-2g-y/pairs --carry-from results/stack-2g-z/pairs \
  --ledge results/ledge/stack-2g-ledge.json --ledge-fit > /dev/null 2>&1 && echo "pooled $tag" || echo "FAIL pooled"
