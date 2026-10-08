#!/bin/zsh
# The second identification a loop makes: the test poses' edges predicted
# again from where the first solve (run.sh b15) put the part, and solved
# with the b15 sweeps' calibration unchanged.
#   second.sh <tag>      e.g. second.sh b15  (needs <tag>-solved-errors.json)
cd "$(dirname "$0")/../../.."
tag=$1; D=notes/brads-notes/2026-10-08-identify
[[ -f generated/believed/stack-2g-test2-$tag/shots.json ]] || \
  node scripts/believed-truth.js generated/stack-2g-test generated/believed/stack-2g-test2-$tag --errors $D/$tag-solved-errors.json
[[ -d generated/stack-2g-test2-$tag ]] || cp -Rc generated/stack-2g-test generated/stack-2g-test2-$tag
IDENTIFY=1 SUFFIX=-$tag notes/brads-notes/2026-10-05-repeat/pool.sh test2 > /dev/null
S=-$tag
SW=(--x results/stack-2g-x$S/pairs --y results/stack-2g-y$S/pairs --z results/stack-2g-z$S/pairs --turn results/stack-2g-turn$S/pairs --test results/stack-2g-test2$S/pairs --max-views 4)
for c in joint hinged; do npm run -s position -- $SW --calibrate $c --out results/identify/stack-2g-$tag-second-$c.json > /dev/null; done
for c in joint hinged; do node notes/brads-notes/2026-10-06-aperture/summary.js results/identify/stack-2g-$tag-second-$c.json; done
