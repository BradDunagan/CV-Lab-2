#!/bin/zsh
# An exposure bracket of the clean stack-2g test poses, through the S-curve
# and with shot noise -- what a camera on a tripod would give -- and the
# curve measured from one frame of it (npm run response).
# NOISE="" TAG=-clean bracket.sh <k>: the same with no noise.
#   bracket.sh <k>
cd "$(dirname "$0")/../../.."
k=$1; i=0; B=bracket${TAG}-s$k
for t in 0.25 0.5 1 2 4; do
  i=$((i+1))
  rm -rf generated/$B-$t
  node scripts/degrade.js generated/stack-2g-test generated/$B-$t --exposure $t --scurve $k ${=NOISE---gain 2000} --seed $i > /dev/null &
done
wait
F=${FRAME:-y35-e20-pose-1.png}
node scripts/response.js --out results/curve/s$k$TAG.json $(for t in 0.25 0.5 1 2 4; do echo generated/$B-$t/$F@$t; done)
