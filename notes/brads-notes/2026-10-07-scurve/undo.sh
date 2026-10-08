#!/bin/zsh
# The S-curve runs with the curve undone (invert.js), analysed and solved as
# variant.sh does: does knowing the curve give back what it cost?
cd "$(dirname "$0")/../../.."
for k in 3 6; do
  ( for r in x y z turn test; do rm -rf generated/stack-2g-$r-s${k}u; node notes/brads-notes/2026-10-07-scurve/invert.js $k generated/stack-2g-$r-s$k generated/stack-2g-$r-s${k}u; done
    P=notes/brads-notes/2026-10-05-repeat/pool.sh; S=-s${k}u
    SUFFIX=$S NOPOOL=1 $P x y z turn > /dev/null; SUFFIX=$S $P x y z turn test > /dev/null
    SW=(--x results/stack-2g-x$S/pairs --y results/stack-2g-y$S/pairs --z results/stack-2g-z$S/pairs --turn results/stack-2g-turn$S/pairs --test results/stack-2g-test$S/pairs --max-views 4)
    for c in joint hinged; do npm run -s position -- $SW --calibrate $c --out results/degrade/stack-2g$S-$c.json > /dev/null; done ) &
done
wait
for k in 3 6; do for c in joint hinged; do node notes/brads-notes/2026-10-06-aperture/summary.js results/degrade/stack-2g-s${k}u-$c.json; done; done
