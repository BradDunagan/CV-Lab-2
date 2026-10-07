#!/bin/zsh
# The degraded stack-2 variants re-analysed with the occluding track, and solved.
cd "$(dirname "$0")/../.."
P=notes/brads-notes/2026-10-05-repeat/pool.sh
for v in "$@"; do
  SUFFIX=$v $P x y z turn test
  SW=(--x results/stack-2g-x$v/pairs --y results/stack-2g-y$v/pairs --z results/stack-2g-z$v/pairs --turn results/stack-2g-turn$v/pairs --test results/stack-2g-test$v/pairs --max-views 4)
  for c in joint hinged; do npm run -s position -- $SW --calibrate $c --out results/degrade/stack-2g$v-$c.json > /dev/null; done
  echo "solved $v"
done
