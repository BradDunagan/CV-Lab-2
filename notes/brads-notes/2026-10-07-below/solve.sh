#!/bin/zsh
# The moving-below runs solved with no truth, four views, from one stage's
# reading of each run (analyse.sh keeps stack-2b-<run>-<stage>).
#   solve.sh <stage> ...
cd ${CODE:-/Users/bradsmac/dev/ai/cv-lab-2-below}
mkdir -p results/below
for st in "$@"; do
  for c in hinged joint; do
    for t in test test-low; do
      npm run -s position -- --x results/stack-2b-x-$st/pairs --y results/stack-2b-y-$st/pairs --z results/stack-2b-z-$st/pairs \
        --turn results/stack-2b-turn-$st/pairs --test results/stack-2b-$t-$st/pairs --max-views 4 --calibrate $c \
        --out results/below/$t-$st-$c.json > results/below/$t-$st-$c.txt
      node notes/brads-notes/2026-10-06-aperture/summary.js results/below/$t-$st-$c.json
    done
  done
done
