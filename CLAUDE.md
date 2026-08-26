# cv-lab-2

An Electron + native C computer-vision lab. Images in, described geometry out —
straight edges with sub-pixel endpoints, and corner hypotheses carrying their
own uncertainty.

Two requirements shape almost every decision: it handles **non-8-bit data**, and
every result is **reproducible** from a replayable log.

## Read these before changing anything

| | |
|---|---|
| `docs/design-lab-model.md` | the model — slots, operations, the command language, provenance, determinism. Written *before* implementation and corrected where reality disagreed |
| `docs/electron-guide.md` | builds, CI, packaging, signing, and the Electron constraints that shaped the architecture. Written *after* doing the work |
| `docs/glossary.md` | terms used in both, explained from scratch |
| `notes/` | working notes; unlike `docs/`, never obliged to be current |

`git log` is part of the record. Commit messages here carry the reasoning,
including the places where a decision was made and later corrected — several
sections of the design doc were wrong until measurement said otherwise, and both
the claim and the correction are written down.

## Shape

```
native/buffer.*      the buffer type: allocation, dtypes, overflow-checked sizing
native/kernels.*     the compute kernels, behind one uniform C signature
native/render.*      display transforms and downsampling, done in C
native/addon_*.c     the Node-API surface
src/lab/registry.js  operation definitions, validation, provenance records
src/lab/parser.js    the command language
src/lab/session.js   slots, execution, the log, the provenance graph
src/lab/corners.js   corner hypotheses (pure JS — no pixels involved)
src/menu.js          the application menu — global commands live here, not in the UI
src/preload.js       owns the session and every buffer handle
src/renderer/        Svelte 5 + paneless; no require, no fs, no pixels
dist-renderer/       what Vite builds from it — this is what Electron loads
test/                eleven suites; ten run under plain node
```

## Commands

Node 22.12+ — see `.nvmrc`. `scripts/check-node.js` runs ahead of install,
build and test, because the requirement used to surface as a `styleText`
export error from inside Vite's plugin chain.

```bash
npm test                # everything — eleven suites, ~287 tests
npm run lint:native     # strict -Wall -Wextra -pedantic on the pure-C sources
npm start               # build the renderer, then launch the app
npm run build:native    # compile the addon
npm run build:renderer  # Vite build of src/renderer/ into dist-renderer/
npm run dev:renderer    # the same, in watch mode
```

## Constraints that are not negotiable without a reason

- **Node-API, never NAN.** One binary works under both Node and Electron. Verified, not assumed.
- **`sandbox: false` on the window**, with `contextIsolation` on and `nodeIntegration` off. It exists so the preload can `require()` a real `.node`. Conditional on this window only ever loading local, first-party content.
- **Pixels never cross the contextBridge.** It deep-copies typed arrays — measured. The preload owns the buffers and renders into the canvas directly. Svelte owns the DOM and only the DOM: a pane hands the preload a canvas **id**, because a DOM node cannot cross the bridge either.
- **A custom application menu must keep `role: 'editMenu'` and `role: 'viewMenu'`.** Electron's default menu is what provides Cmd/Ctrl+C/V/X/A in the command input and Toggle Developer Tools; calling `setApplicationMenu` drops both silently. Pinned by a test.
- **No dev server.** The renderer is always a `file://` URL, built by Vite. `sandbox: false` is conditional on this window only ever loading local, first-party content, and a window that can point at `http://localhost` is a window that can point anywhere.
- **Electron forbids external ArrayBuffers** (`napi_status 22`). C-owned memory cannot be aliased from JS; access is an explicit copy, and the names say so.
- **Determinism rules live in `design-lab-model.md` §5.** Fixed summation order, no `-ffast-math`, and *where two routes reach the same value, make them agree on purpose*. Canonical numbering for anything that assigns identities.

## Working habits that have paid off here

- **Measure before optimising, and before believing.** `merge` was 114× slower than necessary and nothing in the code looked wrong. The default `minMag` was tuned on synthetic images and missed a third of the real ones.
- **Assert properties, not current output.** A test that records what the code produces cannot tell you the code is wrong.
- **A check that runs in one place can pass for the wrong reason.** An implicit `posix_memalign` declaration warned on every Linux build for weeks and never once on macOS.
- **Read CI logs for warnings, not only errors.** That is how the above survived three green checkmarks.
- **Cost is quadratic in segment count, not resolution.** A megapixel of pixel work is ~30 ms; a busy scene is what hurts.

## Open questions

In `design-lab-model.md` §11 — whether `load` should default to `as=linear`;
whether higher-precision decoding is worth a native decoder; and whether
`pt-lab-workspace` writes gamma-encoded or linear PNGs, which matters because
every image in `assets/` declares nothing and the lab assumes sRGB by
convention.
