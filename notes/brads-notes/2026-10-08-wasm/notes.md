# 2026-10-08 (later): pre-port item 2, the C as WebAssembly

Design-lab-model.md §5, rule 6. Branch `wasm`.

## Choices

- wasi-sdk 34 (clang 23.1), pinned by SHA-256 per host, fetched to .tools/.
  Not emscripten: no JS glue wanted, a self-contained versioned tarball, and
  the libm compiled in. The module imports nothing.
- The .wasm is committed (70,788 bytes) with a manifest of source hashes.
  CI: test:wasm on all three runners; Linux fetches the SDK (cached) and
  `build:wasm --check` must rebuild byte-identical.
- fitSegments / fitArcs / bufferFromRGBA8 computed in the Node-API layer;
  moved to native/fits.c, which both surfaces call. Addon hashes unchanged.
- Render spec parsing moved to render.c (cv_render_spec_from_params).
- native/wasm.js mirrors the addon's API and errors (class and message);
  CVLAB_BACKEND=wasm swaps it in behind require('native'). Sessions record
  backend, and the module's SHA-256 as build.

## Defects found

- native/features.h shadowed musl's (and glibc's) <features.h> through
  -Inative. Renamed fits.h.
- CV_MAX_BYTES = (size_t)8 << 30 wraps to 0 in 32-bit size_t: every alloc
  "buffer size overflows". 2 GiB cap where SIZE_MAX is 32-bit.

## Results

- test/determinism.js on wasm: all hashes, first run after the size_t fix.
- test/wasm.js: pow tables (every byte, both ways), toLinear/toSrgb on 12,288
  values, gaussian for 40 sigmas, orient on 4,096 gradients: bit-identical
  between musl (wasm) and Apple's libm (addon). Errors: 29 mistakes, same
  class and message.
- All 16 plain-node suites pass on wasm (smoke's thread-pool test says why it
  cannot apply).
- parity.sh: stack-2g-test, 40 renders, pairs.lab + carry, both backends: 83
  files identical, 920 content hashes. compare.js against a different
  analysis (blur) reports all 83 differing, so it can fail.
- Wall time of that run 150 s addon, 144 s wasm -- Electron startup and JS
  dominate; per-frame kernel cost is item 5.

## Not done

- Other engines (SpiderMonkey, JavaScriptCore): wasm arithmetic is specified
  bit-exactly except NaN payloads, so expected to agree; item 5 runs it in
  a browser.
- No cancellation, no threads: a host's Worker.
