#!/bin/zsh
# Item 6: the -f run's float route analysed again with the package's own
# math, against the same analysis before it (copied to pairs/float-before-math),
# and solved again: does anything but last bits move?
cd "$(dirname "$0")/../../.."
P=notes/brads-notes/2026-10-08-float/pool.sh
FLOAT=1 NOPOOL=1 SUFFIX=-f $P x y z turn
FLOAT=1 SUFFIX=-f $P x y z turn test
SW=(--x results/stack-2g-x-f/pairs/float --y results/stack-2g-y-f/pairs/float --z results/stack-2g-z-f/pairs/float --turn results/stack-2g-turn-f/pairs/float --test results/stack-2g-test-f/pairs/float --max-views 4)
for c in joint hinged; do npm run -s position -- $SW --calibrate $c --out results/float/stack-2g-f-float-$c.json > /dev/null; done
for f in results/float/stack-2g-f-float-{hinged,joint}.before-math.json results/float/stack-2g-f-float-{hinged,joint}.json; do node notes/brads-notes/2026-10-06-aperture/summary.js $f; done
