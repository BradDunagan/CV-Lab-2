#!/bin/zsh
# Item 1's runs again (2026-10-08-identify/run.sh b05 0.5 0.3), with each
# shot's believed truth PREDICTED from the scene's geometry (predictEdges,
# believed-truth --predict) instead of rendered by pt-lab. Same seeds, so the
# same believed poses; the same renders, pooled and solved the same way.
#   run.sh <tag> <margin px>      p05 0: exact visibility; m05 1.5: the default
cd "$(dirname "$0")/../../.."
tag=$1; margin=$2
[[ -f generated/geometry/stack-2/geometry.json ]] || \
  npm run -s generate -- --scene saved:stack-2 --geometry --out generated/geometry/stack-2
seed=0
for r in x y z turn test; do
  seed=$((seed+1))
  [[ -f generated/predicted/stack-2g-$r-$tag/shots.json ]] || \
    node scripts/believed-truth.js generated/stack-2g-$r generated/predicted/stack-2g-$r-$tag --mm 0.5 --deg 0.3 --seed $seed --margin $margin \
      --predict generated/geometry/stack-2/geometry.json
  [[ -d generated/stack-2g-$r-$tag ]] || cp -Rc generated/stack-2g-$r generated/stack-2g-$r-$tag
  node notes/brads-notes/2026-10-08-predict/compare.mjs generated/believed/stack-2g-$r-b05 generated/predicted/stack-2g-$r-$tag
done
P=notes/brads-notes/2026-10-05-repeat/pool.sh; S=-$tag
IDENTIFY=1 IDENTIFY_DIR=generated/predicted SUFFIX=$S NOPOOL=1 $P x y z turn > /dev/null
IDENTIFY=1 IDENTIFY_DIR=generated/predicted SUFFIX=$S $P x y z turn test > /dev/null
SW=(--x results/stack-2g-x$S/pairs --y results/stack-2g-y$S/pairs --z results/stack-2g-z$S/pairs --turn results/stack-2g-turn$S/pairs --test results/stack-2g-test$S/pairs --max-views 4)
mkdir -p results/identify
for c in joint hinged; do npm run -s position -- $SW --calibrate $c --out results/identify/stack-2g$S-$c.json > /dev/null; done
for c in joint hinged; do node notes/brads-notes/2026-10-06-aperture/summary.js results/identify/stack-2g$S-$c.json; done
