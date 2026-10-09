#!/bin/zsh
# Item 1's pt-lab believed truth (-b05) analysed again with today's code, as
# -r05: the baseline the predicted truth is compared against. Item 1's own
# records predate the endsTruePx change and the package's own math.
cd "$(dirname "$0")/../../.."
for r in x y z turn test; do
  [[ -d generated/believed/stack-2g-$r-r05 ]] || cp -Rc generated/believed/stack-2g-$r-b05 generated/believed/stack-2g-$r-r05
  [[ -d generated/stack-2g-$r-r05 ]] || cp -Rc generated/stack-2g-$r generated/stack-2g-$r-r05
done
P=notes/brads-notes/2026-10-05-repeat/pool.sh; S=-r05
IDENTIFY=1 SUFFIX=$S NOPOOL=1 $P x y z turn > /dev/null
IDENTIFY=1 SUFFIX=$S $P x y z turn test > /dev/null
SW=(--x results/stack-2g-x$S/pairs --y results/stack-2g-y$S/pairs --z results/stack-2g-z$S/pairs --turn results/stack-2g-turn$S/pairs --test results/stack-2g-test$S/pairs --max-views 4)
mkdir -p results/identify
for c in joint hinged; do npm run -s position -- $SW --calibrate $c --out results/identify/stack-2g$S-$c.json > /dev/null; done
for c in joint hinged; do node notes/brads-notes/2026-10-06-aperture/summary.js results/identify/stack-2g$S-$c.json; done
