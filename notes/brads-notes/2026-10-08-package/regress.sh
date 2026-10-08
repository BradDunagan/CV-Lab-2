#!/bin/zsh
# solve-position and servo's logic moved into the vision package: every mode
# of the script run before and after, and every output compared byte for
# byte. regress.sh <outdir>
cd "$(dirname "$0")/../../.."
O=$1; mkdir -p $O
R=results; P=pairs
SW=(--x $R/stack-2g-x/$P --y $R/stack-2g-y/$P --z $R/stack-2g-z/$P --turn $R/stack-2g-turn/$P --test $R/stack-2g-test/$P --max-views 4)
run() { local name=$1; shift; npm run -s position -- "$@" --out $O/$name.json > $O/$name.txt 2>&1; echo "$name $?"; }
run truth $SW
run joint $SW --calibrate joint
run hinged $SW --calibrate hinged --save-calibration $O/hinged-cal.json
run full $SW --calibrate full
run reference $SW --calibrate reference
run robust $SW --calibrate hinged --robust 0.05 --readings ends --weights none --max-residual 0.4
run lift $SW --calibrate hinged --lift $R/stack-2g-x-lift1.5/$P --lift $R/stack-2g-z-lift1.5/$P --lift $R/stack-2g-turn-lift1.5/$P
run tip --x $R/stack-2g-x/$P --y $R/stack-2g-y/$P --z $R/stack-2g-z/$P --turn $R/stack-2g-turn/$P --tipx $R/stack-2g-tipx/$P --tipz $R/stack-2g-tipz/$P --test $R/stack-2g-test-tip/$P --max-views 4 --calibrate hinged --tip-prior 0.5
run sequence $SW --calibrate hinged --sequence $R/stack-2g-approach/$P --trials 5
# The closed loop's dry run: no renders, readings from the calibration's own
# model plus seeded noise.
for seed in 1 2; do
  npm run -s servo -- --name regress-$seed --calibration $O/hinged-cal.json --start 1.5,4,-1,1 --dry-run --seed $seed > $O/servo-$seed.txt 2>&1; echo "servo-$seed $?"
  cp results/servo/regress-$seed/servo.json $O/servo-$seed.json
done
