#!/bin/zsh
# Item 5: one frame's cost -- pipelines/pairs.lab less explain/match, plus the
# frame's carried trackPair commands -- on the native addon, the module under
# Node, and the module in Chrome's and Firefox's Web Workers. Test pose 1 of
# stack-2g, four views, at 512 (the -f run's frames), 1024 and 2048 (rendered
# for this: generate --float, the same shots). Nothing else running.
cd "$(dirname "$0")/../../.."
# The frames: 512 copied from the -f run, 1024 and 2048 rendered from its shots.
if [[ ! -d generated/bench-2048 ]]; then
  mkdir -p generated/bench-512 && cp generated/stack-2g-test-f/y*-pose-1.pfm generated/bench-512/
  node -e "const s=require('./generated/stack-2g-test-f/shots.json');require('fs').writeFileSync('/tmp/pose1.json',JSON.stringify(s.filter(x=>x.pose===1)))"
  for z in 1024 2048; do npx electron scripts/generate-cli.js --out generated/bench-$z --scene saved:stack-2 \
    --shots /tmp/pose1.json --size $z --samples 96 --tone-mapping linear --exposure 0.5 --float; done
fi
C=~/Library/Caches/ms-playwright
B=(--backends native,wasm --browsers chromium,firefox --playwright ../rr/node_modules
   --browser-exe chromium=chrome --browser-exe firefox=$C/firefox-1497/firefox/Nightly.app/Contents/MacOS/firefox
   --carry results/stack-2g-test-f/pairs/float/carry-commands.json)
O=notes/brads-notes/2026-10-08-bench
node scripts/bench.js generated/bench-512 $B --scale 1 --reps 5 --out $O/bench-512.json
node scripts/bench.js generated/bench-1024 $B --scale 2 --reps 3 --out $O/bench-1024.json
node scripts/bench.js generated/bench-2048 $B --scale 4 --reps 2 --out $O/bench-2048.json
