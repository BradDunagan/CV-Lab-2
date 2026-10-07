#!/bin/zsh
# Blur, offsets at flush, both pairs, every shadow width the clean table's
# times SCALE: does the calibration's own residual find the right width?
#   scale.sh <scale>
cd "$(dirname "$0")"
export MODE=flush PAIRS=all OMEGA_SCALE=$1
S=-s$1
FLUSH=stack-2g-y-blur node variant.js kappa-clean.json $S stack-2g-x-blur stack-2g-y-blur stack-2g-z-blur stack-2g-turn-blur stack-2g-test-blur > /dev/null
cd ../../..
npm run -s position -- --x results/stack-2g-x-blur$S/pairs --y results/stack-2g-y-blur$S/pairs --z results/stack-2g-z-blur$S/pairs --turn results/stack-2g-turn-blur$S/pairs --test results/stack-2g-test-blur$S/pairs --max-views 4 --calibrate joint --out results/ledge/blur$S-joint.json > /dev/null
node notes/brads-notes/2026-10-06-aperture/summary.js results/ledge/blur$S-joint.json
