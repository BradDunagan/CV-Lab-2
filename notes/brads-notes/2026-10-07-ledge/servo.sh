#!/bin/zsh
# The loop with the ledge held at the believed lift, against the twenty-
# seventh's (hinged, 4 mm, --lateral-floor 0), from its two starts. The
# sweeps (results/stack-2g-*) are the ones re-analysed with --ledge.
cd "$(dirname "$0")/../../.."
L=results/stack-2g
SW=(--x $L-x/pairs --y $L-y/pairs --z $L-z/pairs --turn $L-turn/pairs --max-views 4)
npm run -s position -- $SW --calibrate hinged --save-calibration results/servo/stack-2g-hinged-ledge.calibration.json > /dev/null
POOL=(--carry-from $L-x/pairs --carry-from $L-y/pairs --carry-from $L-z/pairs --carry-from $L-turn/pairs)
LEDGE=(--ledge results/ledge/stack-2g-ledge.json)
npm run -s servo -- --name ledge-a-f0 --calibration results/servo/stack-2g-hinged-ledge.calibration.json \
  --start 1.5,6,-1.2,1.5 --seed 1 --lateral-floor 0 $POOL $LEDGE > notes/brads-notes/2026-10-07-ledge/servo-a.log 2>&1 && echo "servo a" || echo "FAIL servo a"
npm run -s servo -- --name ledge-b-f0 --calibration results/servo/stack-2g-hinged-ledge.calibration.json \
  --start -2,7,1.8,-2.5 --seed 2 --lateral-floor 0 $POOL $LEDGE > notes/brads-notes/2026-10-07-ledge/servo-b.log 2>&1 && echo "servo b" || echo "FAIL servo b"
