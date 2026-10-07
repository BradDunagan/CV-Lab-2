#!/bin/zsh
# A cheaper light search: the calibration from nine positions (the reference,
# and one step either way along x, y, z and the turn) instead of 25, and the
# verdict from three commanded test poses instead of ten. Rows subset from
# each light's full runs (subset.js); solved hinged as light.sh does.
#   subset.sh <prefix> ...
cd "$(dirname "$0")/../../.."
for pre in "$@"; do
  node notes/brads-notes/2026-10-06-light/subset.js $pre
  S=(--x results/$pre-x-sub/pairs --y results/$pre-y-sub/pairs --z results/$pre-z-sub/pairs --turn results/$pre-turn-sub/pairs --max-views 4 --calibrate hinged)
  npm run -s position -- $S --test results/$pre-test-sub/pairs --out results/light/$pre-sub3-hinged.json > /dev/null
  npm run -s position -- $S --test results/$pre-test/pairs --out results/light/$pre-sub10-hinged.json > /dev/null
done
