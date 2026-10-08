#!/bin/zsh
# The stack-2g sweeps and test poses analysed with each detected edge
# identified from where the robot BELIEVES the part is, not from the
# renderer's truth: believed truth rendered with a seeded pose error per
# pose (npm run believed-truth), then pooled and solved as the clean runs
# were (2026-10-05-repeat/pool.sh), scored on the real poses.
#   run.sh <tag> <mm sd> <deg sd>     e.g. run.sh b05 0.5 0.3
cd "$(dirname "$0")/../../.."
tag=$1; mm=$2; deg=$3; seed=0
for r in x y z turn test; do
  seed=$((seed+1))
  [[ -f generated/believed/stack-2g-$r-$tag/shots.json ]] || \
    node scripts/believed-truth.js generated/stack-2g-$r generated/believed/stack-2g-$r-$tag --mm $mm --deg $deg --seed $seed
  [[ -d generated/stack-2g-$r-$tag ]] || cp -Rc generated/stack-2g-$r generated/stack-2g-$r-$tag
done
P=notes/brads-notes/2026-10-05-repeat/pool.sh; S=-$tag
IDENTIFY=1 SUFFIX=$S NOPOOL=1 $P x y z turn > /dev/null
IDENTIFY=1 SUFFIX=$S $P x y z turn test > /dev/null
SW=(--x results/stack-2g-x$S/pairs --y results/stack-2g-y$S/pairs --z results/stack-2g-z$S/pairs --turn results/stack-2g-turn$S/pairs --test results/stack-2g-test$S/pairs --max-views 4)
mkdir -p results/identify
for c in joint hinged; do npm run -s position -- $SW --calibrate $c --out results/identify/stack-2g$S-$c.json > /dev/null; done
for c in joint hinged; do node notes/brads-notes/2026-10-06-aperture/summary.js results/identify/stack-2g$S-$c.json; done
