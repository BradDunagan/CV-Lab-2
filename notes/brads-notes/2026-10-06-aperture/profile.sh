#!/bin/zsh
# One stack-2 variant (clean or degraded) re-analysed under another pair-fit
# profile, beside the box results, and solved with no truth.
#   profile.sh <variant-suffix> <profile>[-pairs]   e.g. profile.sh -blur smooth-pairs
# (-pairs: each wide pair measures its own aperture, CVLAB_APERTURE=pairs)
# Reads generated/stack-2g-<r><variant>; writes results/stack-2g-<r><variant>-<profile>
# through symlinked generated/ names, so the box results are left alone.
set -e
cd "$(dirname "$0")/../../.."
v=$1; prof=$2; suf=$v-$prof
for r in x y z turn test; do
  [[ -e generated/stack-2g-$r$suf ]] || ln -s stack-2g-$r$v generated/stack-2g-$r$suf
done
P=notes/brads-notes/2026-10-05-repeat/pool.sh
export CVLAB_PROFILE=${prof%-pairs}
[[ $prof == *-pairs ]] && export CVLAB_APERTURE=pairs
SUFFIX=$suf NOPOOL=1 $P x y z turn
SUFFIX=$suf $P x y z turn test
SW=(--x results/stack-2g-x$suf/pairs --y results/stack-2g-y$suf/pairs --z results/stack-2g-z$suf/pairs
    --turn results/stack-2g-turn$suf/pairs --test results/stack-2g-test$suf/pairs --max-views 4)
mkdir -p results/degrade
for c in joint hinged; do
  npm run -s position -- $SW --calibrate $c --out results/degrade/stack-2g$suf-$c.json > /dev/null
done
echo "solved $suf"
