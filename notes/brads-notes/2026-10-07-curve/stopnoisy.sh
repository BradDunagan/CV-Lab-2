#!/bin/zsh
# stop.sh with shot noise (--gain 2000) in the images, and the curve from the
# noisy bracket: the realistic case. -h0n baseline, -s6hn left in, -s6hnm undone.
cd "$(dirname "$0")/../../.."
V=notes/brads-notes/2026-10-05-degrade/variant.sh
$V -h0n --exposure 0.5 --gain 2000 > /dev/null 2>&1 &
$V -s6hn --exposure 0.5 --scurve 6 --gain 2000 > /dev/null 2>&1
KS=6 SRC=hn TAG=hnm CURVEF= notes/brads-notes/2026-10-07-curve/measured.sh > /dev/null 2>&1
wait
for s in h0n s6hn s6hnm; do for c in joint hinged; do node notes/brads-notes/2026-10-06-aperture/summary.js results/degrade/stack-2g-$s-$c.json; done; done
