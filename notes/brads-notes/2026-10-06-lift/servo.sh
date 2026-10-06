#!/bin/zsh
# Item 3 in the loop: the lift-aware calibration against the 4 mm one, both
# with --lateral-floor 0 (sideways correction all the way down), from the two
# starts of 2026-10-05.
cd "$(dirname "$0")/../../.."
L=results/stack-2g
SW=(--x $L-x/pairs --y $L-y/pairs --z $L-z/pairs --turn $L-turn/pairs --max-views 4 --calibrate hinged)
npm run -s position -- $SW --save-calibration results/servo/stack-2g-hinged-occl.calibration.json > /dev/null
npm run -s position -- $SW --lift $L-x-lift1.5/pairs --lift $L-z-lift1.5/pairs --lift $L-turn-lift1.5/pairs \
  --save-calibration results/servo/stack-2g-lifted-occl.calibration.json > /dev/null
POOL=(--carry-from $L-x/pairs --carry-from $L-y/pairs --carry-from $L-z/pairs --carry-from $L-turn/pairs)
for cal in hinged lifted; do
  npm run -s servo -- --name $cal-a-f0 --calibration results/servo/stack-2g-$cal-occl.calibration.json \
    --start 1.5,6,-1.2,1.5 --seed 1 --lateral-floor 0 $POOL > /tmp/servo-$cal-a.log 2>&1 && echo "servo $cal a" || echo "FAIL servo $cal a"
  npm run -s servo -- --name $cal-b-f0 --calibration results/servo/stack-2g-$cal-occl.calibration.json \
    --start -2,7,1.8,-2.5 --seed 2 --lateral-floor 0 $POOL > /tmp/servo-$cal-b.log 2>&1 && echo "servo $cal b" || echo "FAIL servo $cal b"
done
