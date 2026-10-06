#!/bin/zsh
# One distortion variant of the 1024 px stack-2 renders, shrunk to 512 and
# analysed and solved as the other variants are.
#   variant.sh <suffix> <degrade.js options...>   e.g. variant.sh -ds   (control: --downsample 2 only)
#                                                     variant.sh -k2 --k1 -0.02 --interp cubic
# RUNS="x y" limits which runs are made and analysed (a first pass only).
set -e
cd "$(dirname "$0")/../../.."
suffix=$1; shift
runs=(${=RUNS:-x y z turn test})
for r in $runs; do
  [[ -d generated/stack-2g-$r-1k ]] || { echo "no generated/stack-2g-$r-1k"; exit 1; }
  rm -rf generated/stack-2g-$r$suffix
  node scripts/degrade.js generated/stack-2g-$r-1k generated/stack-2g-$r$suffix --downsample 2 "$@" > /dev/null
done
P=notes/brads-notes/2026-10-05-repeat/pool.sh
first=(${runs:#test})
SUFFIX=$suffix NOPOOL=1 $P $first
[[ -n $RUNS ]] && { echo "first pass $suffix"; exit 0; }
SUFFIX=$suffix $P x y z turn test
SW=(--x results/stack-2g-x$suffix/pairs --y results/stack-2g-y$suffix/pairs --z results/stack-2g-z$suffix/pairs
    --turn results/stack-2g-turn$suffix/pairs --test results/stack-2g-test$suffix/pairs --max-views 4)
mkdir -p results/degrade
for c in joint hinged; do
  npm run -s position -- $SW --calibrate $c --out results/degrade/stack-2g$suffix-$c.json > /dev/null
done
echo "solved $suffix"
