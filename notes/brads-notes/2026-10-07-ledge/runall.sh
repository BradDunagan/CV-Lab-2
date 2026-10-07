#!/bin/zsh
# MODE=... FLUSH-suffix: variant of every run, clean and blur, then solves.
# runall.sh <suffix> <mode> [gate]
cd "$(dirname "$0")"
S=$1; export MODE=$2; export GATE=${3:-0.5}
FLUSH=stack-2g-y node variant.js kappa-clean.json $S stack-2g-x stack-2g-y stack-2g-z stack-2g-turn stack-2g-test stack-2g-test-r2 stack-2g-test-r3 stack-2g-test-low
FLUSH=stack-2g-y-blur node variant.js kappa-clean.json $S stack-2g-x-blur stack-2g-y-blur stack-2g-z-blur stack-2g-turn-blur stack-2g-test-blur
cd ../../..
for c in hinged joint; do
  for t in test test-r2 test-r3 test-low; do
    npm run -s position -- --x results/stack-2g-x$S/pairs --y results/stack-2g-y$S/pairs --z results/stack-2g-z$S/pairs --turn results/stack-2g-turn$S/pairs --test results/stack-2g-$t$S/pairs --max-views 4 --calibrate $c --out results/ledge/$t$S-$c.json > /dev/null
    node notes/brads-notes/2026-10-06-aperture/summary.js results/ledge/$t$S-$c.json
  done
  npm run -s position -- --x results/stack-2g-x-blur$S/pairs --y results/stack-2g-y-blur$S/pairs --z results/stack-2g-z-blur$S/pairs --turn results/stack-2g-turn-blur$S/pairs --test results/stack-2g-test-blur$S/pairs --max-views 4 --calibrate $c --out results/ledge/blur$S-$c.json > /dev/null
  node notes/brads-notes/2026-10-06-aperture/summary.js results/ledge/blur$S-$c.json
done
