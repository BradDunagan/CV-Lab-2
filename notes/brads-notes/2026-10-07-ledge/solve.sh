#!/bin/zsh
# Solve test poses, hinged, no truth, from runs with suffix $1 (sweeps) and
# test runs $2..., printing the summary per test run.
cd "$(dirname "$0")/../../.."
S=$1; V=$2; shift 2
mkdir -p results/ledge
for t in "$@"; do
  out=results/ledge/stack-2g$V-$t$S.json
  npm run -s position -- --x results/stack-2g-x$V$S/pairs --y results/stack-2g-y$V$S/pairs --z results/stack-2g-z$V$S/pairs \
    --turn results/stack-2g-turn$V$S/pairs --test results/stack-2g-$t$V$S/pairs --max-views 4 --calibrate hinged --out $out > /dev/null
  node notes/brads-notes/2026-10-06-aperture/summary.js $out
done
