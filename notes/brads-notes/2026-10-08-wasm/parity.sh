#!/bin/zsh
# Real-image parity: the stack-2g test poses (40 path-traced shots) analysed
# by gap-sweep --carry with pipelines/pairs.lab, once on the addon and once on
# the WebAssembly build, and every output compared.
cd "$(dirname "$0")/../../.."
for b in native wasm; do
  [[ -d generated/stack-2g-test-$b ]] || cp -Rc generated/stack-2g-test generated/stack-2g-test-$b
  rm -rf results/stack-2g-test-$b
  start=$(date +%s)
  if [[ $b == wasm ]]; then export CVLAB_BACKEND=wasm; else unset CVLAB_BACKEND; fi
  NOPOOL=1 SUFFIX=-$b notes/brads-notes/2026-10-05-repeat/pool.sh test
  echo "$b: $(( $(date +%s) - start )) s"
done
unset CVLAB_BACKEND
node notes/brads-notes/2026-10-08-wasm/compare.js results/stack-2g-test-native/pairs results/stack-2g-test-wasm/pairs
