#!/bin/zsh
# Blur, both pairs, offsets at flush, widths measured on blur's own frames.
cd "$(dirname "$0")"
S=-fab; export MODE=flush PAIRS=all
FLUSH=stack-2g-y-blur node variant.js kappa-blur.json $S stack-2g-x-blur stack-2g-y-blur stack-2g-z-blur stack-2g-turn-blur stack-2g-test-blur
cd ../../..
for c in hinged joint; do
  npm run -s position -- --x results/stack-2g-x-blur$S/pairs --y results/stack-2g-y-blur$S/pairs --z results/stack-2g-z-blur$S/pairs --turn results/stack-2g-turn-blur$S/pairs --test results/stack-2g-test-blur$S/pairs --max-views 4 --calibrate $c --out results/ledge/blur$S-$c.json > /dev/null
  node notes/brads-notes/2026-10-06-aperture/summary.js results/ledge/blur$S-$c.json
done
