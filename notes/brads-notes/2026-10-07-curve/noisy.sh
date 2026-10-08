#!/bin/zsh
# The realistic case: shot noise in the images as well as in the bracket.
# A noise-only baseline (-n0), the S-curve k = 6 left in (-s6n), and the same
# images through the curve measured from the noisy bracket (-s6nm).
cd "$(dirname "$0")/../../.."
V=notes/brads-notes/2026-10-05-degrade/variant.sh
$V -n0 --gain 2000 > /dev/null 2>&1 &
$V -s6n --scurve 6 --gain 2000 > /dev/null 2>&1
KS=6 SRC=n notes/brads-notes/2026-10-07-curve/measured.sh > /dev/null 2>&1
wait
for s in n0 s6n s6nm; do for c in joint hinged; do node notes/brads-notes/2026-10-06-aperture/summary.js results/degrade/stack-2g-$s-$c.json; done; done
