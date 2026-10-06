#!/bin/zsh
# The second round, after the first: per-pair apertures, both profiles.
cd "$(dirname "$0")"
while pgrep -f "profile.sh" > /dev/null; do sleep 30; done
for a in "-blur:smooth-pairs" "-blur:box-pairs" ":smooth-pairs" ":box-pairs"; do
  v=${a%%:*}; p=${a##*:}; ( time ./profile.sh "$v" $p ) > run$v-$p.log 2>&1 &
done
wait
for a in "-distort2:smooth-pairs" "-all:smooth-pairs" "-distort2:box-pairs" "-all:box-pairs"; do
  v=${a%%:*}; p=${a##*:}; ( time ./profile.sh "$v" $p ) > run$v-$p.log 2>&1 &
done
wait
echo queue finished
