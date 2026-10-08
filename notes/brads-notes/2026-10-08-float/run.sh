#!/bin/zsh
# Item 4: the stack-2g sweeps and test poses rendered once, written both as
# the usual 8-bit sRGB PNG and as linear float (.pfm) from the same samples,
# then each pooled and solved exactly as 2026-10-08-identify/run.sh did the
# clean runs. The only difference between the two answers is the input route.
#   run.sh          render (once), analyse both, solve both
cd "$(dirname "$0")/../../.."
P=notes/brads-notes/2026-10-08-float/pool.sh
[[ -n $1 ]] || {
[[ -f generated/stack-2g-test-f/shots.json ]] || RENDER=1 FLOAT=1 NOPOOL=1 SUFFIX=-f $P x y z turn test
mkdir -p results/float
for F in '' 1; do
  FD=; [[ -n $F ]] && FD=/float
  FLOAT=$F NOPOOL=1 SUFFIX=-f $P x y z turn
  FLOAT=$F SUFFIX=-f $P x y z turn test
  SW=(--x results/stack-2g-x-f/pairs$FD --y results/stack-2g-y-f/pairs$FD --z results/stack-2g-z-f/pairs$FD --turn results/stack-2g-turn-f/pairs$FD --test results/stack-2g-test-f/pairs$FD --max-views 4)
  tag=${F:+float}; tag=${tag:-png}
  for c in joint hinged; do npm run -s position -- $SW --calibrate $c --out results/float/stack-2g-f-$tag-$c.json > /dev/null; done
done
for f in results/float/stack-2g-f-*.json; do node notes/brads-notes/2026-10-06-aperture/summary.js $f; done
}

# The old renders (2026-10-05/07) through exactly this pipeline, PNG route:
# is a difference from item 1's clean baseline the renders or the analysis?
#   run.sh old
if [[ $1 == old ]]; then
  for r in x y z turn test; do [[ -d generated/stack-2g-$r-o ]] || cp -Rc generated/stack-2g-$r generated/stack-2g-$r-o; done
  NOPOOL=1 SUFFIX=-o $P x y z turn
  SUFFIX=-o $P x y z turn test
  SW=(--x results/stack-2g-x-o/pairs --y results/stack-2g-y-o/pairs --z results/stack-2g-z-o/pairs --turn results/stack-2g-turn-o/pairs --test results/stack-2g-test-o/pairs --max-views 4)
  for c in joint hinged; do npm run -s position -- $SW --calibrate $c --out results/float/stack-2g-o-png-$c.json > /dev/null; done
  for f in results/float/stack-2g-o-*.json; do node notes/brads-notes/2026-10-06-aperture/summary.js $f; done
fi

# One stop over: the -f runs at twice the exposure, made by brighter.mjs from
# their float frames (12.8% of pixels clip in the PNG), both routes.
#   run.sh bright
if [[ $1 == bright ]]; then
  for r in x y z turn test; do [[ -d generated/stack-2g-$r-f2 ]] || node notes/brads-notes/2026-10-08-float/brighter.mjs generated/stack-2g-$r-f generated/stack-2g-$r-f2 2; done
  for F in '' 1; do
    FD=; [[ -n $F ]] && FD=/float
    FLOAT=$F NOPOOL=1 SUFFIX=-f2 $P x y z turn
    FLOAT=$F SUFFIX=-f2 $P x y z turn test
    SW=(--x results/stack-2g-x-f2/pairs$FD --y results/stack-2g-y-f2/pairs$FD --z results/stack-2g-z-f2/pairs$FD --turn results/stack-2g-turn-f2/pairs$FD --test results/stack-2g-test-f2/pairs$FD --max-views 4)
    tag=${F:+float}; tag=${tag:-png}
    for c in joint hinged; do npm run -s position -- $SW --calibrate $c --out results/float/stack-2g-f2-$tag-$c.json > /dev/null; done
  done
  for f in results/float/stack-2g-f2-*.json; do node notes/brads-notes/2026-10-06-aperture/summary.js $f; done
fi
