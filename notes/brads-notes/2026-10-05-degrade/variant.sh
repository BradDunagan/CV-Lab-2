#!/bin/zsh
# One degraded copy of the stack-2 sweeps and test poses, analysed and solved.
#   variant.sh <suffix> <degrade.js options...>
# e.g. variant.sh -noisy --gain 2000 --read 0.002   (options: npm run degrade)
set -e
cd "$(dirname "$0")/../../.."
suffix=$1; shift
for r in x y z turn test; do
  node scripts/degrade.js generated/stack-2g-$r generated/stack-2g-$r$suffix "$@" > /dev/null
done
P=notes/brads-notes/2026-10-05-repeat/pool.sh
SUFFIX=$suffix NOPOOL=1 $P x y z turn
SUFFIX=$suffix $P x y z turn test
SW=(--x results/stack-2g-x$suffix/pairs --y results/stack-2g-y$suffix/pairs --z results/stack-2g-z$suffix/pairs
    --turn results/stack-2g-turn$suffix/pairs --test results/stack-2g-test$suffix/pairs --max-views 4)
mkdir -p results/degrade
for c in joint hinged; do
  npm run -s position -- $SW --calibrate $c --out results/degrade/stack-2g$suffix-$c.json > /dev/null
done
echo "solved $suffix"
