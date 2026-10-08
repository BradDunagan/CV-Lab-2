#!/bin/zsh
# The S-curve runs (2026-10-07-scurve) analysed through the curve measured
# from a bracket (bracket.sh), and solved as variant.sh does: does a
# measured curve give back what an exact one did?
#   measured.sh        results/curve/s<k>.json, suffix -s<k>m
#   measured.sh exact  results/curve/s<k>-exact.json (exact.js), suffix -s<k>e
#   measured.sh clean  results/curve/s<k>-clean.json, from a noise-free bracket, suffix -s<k>c
# KS="6" for one strength only. SRC=n: from the noisy runs (-s<k>n, noisy.sh),
# through the curve from the noisy bracket, suffix -s<k>nm.
cd "$(dirname "$0")/../../.."
T=m; F=; [[ $1 == exact ]] && T=e && F=-exact
[[ $1 == clean ]] && T=c && F=-clean
N=${SRC:-}; T=$N$T
# Any other curve: TAG=<suffix letter> CURVEF=<-name> measured.sh
[[ -n $TAG ]] && T=$TAG && F=$CURVEF
for k in ${=KS:-3 6}; do
  ( for r in x y z turn test; do rm -rf generated/stack-2g-$r-s$k$T; cp -Rc generated/stack-2g-$r-s$k$N generated/stack-2g-$r-s$k$T; done
    P=notes/brads-notes/2026-10-05-repeat/pool.sh; S=-s$k$T
    CURVE=results/curve/s$k$F.json SUFFIX=$S NOPOOL=1 $P x y z turn > /dev/null
    CURVE=results/curve/s$k$F.json SUFFIX=$S $P x y z turn test > /dev/null
    SW=(--x results/stack-2g-x$S/pairs --y results/stack-2g-y$S/pairs --z results/stack-2g-z$S/pairs --turn results/stack-2g-turn$S/pairs --test results/stack-2g-test$S/pairs --max-views 4)
    for c in joint hinged; do npm run -s position -- $SW --calibrate $c --out results/degrade/stack-2g$S-$c.json > /dev/null; done ) &
done
wait
for k in ${=KS:-3 6}; do for c in joint hinged; do node notes/brads-notes/2026-10-06-aperture/summary.js results/degrade/stack-2g-s$k$T-$c.json; done; done
