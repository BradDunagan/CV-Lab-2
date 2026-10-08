#!/bin/zsh
# A camera's response curve left in, stronger than the gamma 2.2 of the
# twenty-fourth: a filmic S-curve (degrade --scurve). Each a degraded copy of
# the stack-2g sweeps and test poses, analysed with the pooled still edge
# (no ledge) and solved, by 2026-10-05-degrade/variant.sh.
cd "$(dirname "$0")/../../.."
V=notes/brads-notes/2026-10-05-degrade/variant.sh
$V -c0 > notes/brads-notes/2026-10-07-scurve/c0.log 2>&1 &
$V -g22 --gamma 2.2 > notes/brads-notes/2026-10-07-scurve/g22.log 2>&1 &
$V -s3 --scurve 3 > notes/brads-notes/2026-10-07-scurve/s3.log 2>&1 &
$V -s6 --scurve 6 > notes/brads-notes/2026-10-07-scurve/s6.log 2>&1 &
wait
for s in c0 g22 s3 s6; do for c in joint hinged; do node notes/brads-notes/2026-10-06-aperture/summary.js results/degrade/stack-2g-$s-$c.json; done; done
