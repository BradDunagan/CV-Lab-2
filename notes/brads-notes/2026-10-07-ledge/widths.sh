#!/bin/zsh
# Blur only, offsets at flush, both pairs, the shadow's width held at WIDTH px
# in every frame: how sensitive is the reading to the width?
#   widths.sh <width> ...
cd "$(dirname "$0")"
export MODE=flush PAIRS=all
for w in "$@"; do
  S=-w$w
  WIDTH=$w FLUSH=stack-2g-y-blur node variant.js kappa-clean.json $S stack-2g-x-blur stack-2g-y-blur stack-2g-z-blur stack-2g-turn-blur stack-2g-test-blur > /dev/null
  (cd ../../.. && npm run -s position -- --x results/stack-2g-x-blur$S/pairs --y results/stack-2g-y-blur$S/pairs --z results/stack-2g-z-blur$S/pairs --turn results/stack-2g-turn-blur$S/pairs --test results/stack-2g-test-blur$S/pairs --max-views 4 --calibrate joint --out results/ledge/blur$S-joint.json > /dev/null && node notes/brads-notes/2026-10-06-aperture/summary.js results/ledge/blur$S-joint.json)
done
