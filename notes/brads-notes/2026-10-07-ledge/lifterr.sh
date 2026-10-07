#!/bin/zsh
# The test renders read with every commanded lift off by $1 mm (sweeps exact).
cd "$(dirname "$0")"
E=$1; S=-fa; T=-fa-l$E; export MODE=flush PAIRS=all LIFT_ERR=$E
FLUSH=stack-2g-y node variant.js kappa-clean.json $T stack-2g-test stack-2g-test-low
cd ../../..
for t in test test-low; do
  npm run -s position -- --x results/stack-2g-x$S/pairs --y results/stack-2g-y$S/pairs --z results/stack-2g-z$S/pairs --turn results/stack-2g-turn$S/pairs --test results/stack-2g-$t$T/pairs --max-views 4 --calibrate joint --out results/ledge/$t$T-joint.json > /dev/null
  node notes/brads-notes/2026-10-06-aperture/summary.js results/ledge/$t$T-joint.json
done
