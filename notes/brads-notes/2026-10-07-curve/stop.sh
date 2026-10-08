#!/bin/zsh
# One stop under: the k = 6 runs exposed at 0.5, so the lit faces stop
# reaching code 255. A no-curve baseline at that exposure (-h0), the curve
# left in (-s6h), and undone with the curve measured from the noise-free
# bracket (-s6hc).
cd "$(dirname "$0")/../../.."
V=notes/brads-notes/2026-10-05-degrade/variant.sh
$V -h0 --exposure 0.5 > /dev/null 2>&1 &
$V -s6h --exposure 0.5 --scurve 6 > /dev/null 2>&1
KS=6 SRC=h TAG=hc CURVEF=-clean notes/brads-notes/2026-10-07-curve/measured.sh > /dev/null 2>&1
wait
for s in h0 s6h s6hc; do for c in joint hinged; do node notes/brads-notes/2026-10-06-aperture/summary.js results/degrade/stack-2g-$s-$c.json; done; done
