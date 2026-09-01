# cv-lab-2

An Electron + native C computer-vision lab. Images in, described geometry out —
straight edges with sub-pixel endpoints, and corner hypotheses carrying their
own uncertainty.

Two requirements shape almost every decision: it handles **non-8-bit data**, and
every result is **reproducible** from a replayable log.

## Read these before changing anything

| | |
|---|---|
| `docs/cv-lab-users-manual.md` | how to **use** it — every operation and parameter, the workflows, what the outputs mean, what it deliberately does not do |
| `docs/design-lab-model.md` | the model — slots, operations, the command language, provenance, determinism. Written *before* implementation and corrected where reality disagreed |
| `docs/electron-guide.md` | builds, CI, packaging, signing, and the Electron constraints that shaped the architecture. Written *after* doing the work |
| `docs/glossary.md` | terms used in all of them, explained from scratch |
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
src/lab/groundtruth.js   reads a renderer's ground truth in as features
src/lab/match.js     scores detected features against it (pure JS)
scripts/lab-cli.js   headless batch runner: a pipeline over many images
scripts/generate-cli.js  drives pt-lab to render varied images (needs a GPU)
scripts/score.js     tallies match records: precision, recall, and which
                     corner field actually discriminates
scripts/overlay.js   draws ground truth and detections over an image — every
                     defect in the scoring machinery was found this way
src/generate/        the generator: page (bundled separately) + main-process
                     driver shared by the CLI and the app's Generate frame
src/menu.js          the application menu — global commands live here, not in the UI
src/preload.js       owns the session and every buffer handle
src/renderer/        Svelte 5 + paneless; no require, no fs, no pixels
dist-renderer/       what Vite builds from it — this is what Electron loads
test/                fourteen suites; thirteen run under plain node
pipelines/           .lab scripts for the batch runner
```

## Commands

Node 22.12+ — see `.nvmrc`. `scripts/check-node.js` runs ahead of install,
build and test, because the requirement used to surface as a `styleText`
export error from inside Vite's plugin chain.

```bash
npm test                # everything — fourteen suites, ~347 tests
npm run lint:native     # strict -Wall -Wextra -pedantic on the pure-C sources
npm start               # build the renderer, then launch the app
npm run lab -- --help   # run a pipeline over images, headless
npm run score -- results/           # found, against what is really there
npm run overlay -- <img> results/   # ...and the same thing as a picture
npm run build:native    # compile the addon
npm run build:renderer  # Vite build of src/renderer/ into dist-renderer/
npm run dev:renderer    # the same, in watch mode
npm run build:generate  # the generator bundle — rerun whenever pt-lab's source
                        # changes; a stale one is refused rather than run
npm run package         # installers; builds the generator INTO the app
npm run verify:package  # the artifact's layout
npm run smoke:package   # launch it and check it actually works
```

## Constraints that are not negotiable without a reason

- **Node-API, never NAN.** One binary works under both Node and Electron. Verified, not assumed.
- **Image generation ships in the app.** It is not a developer tool: varying lighting and pose to test a pipeline against is the lab's core loop, so `npm run package` builds `dist-generate/` into the `app.asar`. That is why pt-lab is a *build* dependency only — the bundle carries the tracer, the model and the environment. Needs a GPU; adds ~17 MB.
- **`sandbox: false` on the window**, with `contextIsolation` on and `nodeIntegration` off. It exists so the preload can `require()` a real `.node`. Conditional on this window only ever loading local, first-party content.
- **Pixels never cross the contextBridge.** It deep-copies typed arrays — measured. The preload owns the buffers and renders into the canvas directly. Svelte owns the DOM and only the DOM: a pane hands the preload a canvas **id**, because a DOM node cannot cross the bridge either.
- **The macOS menu-bar name is `CFBundleName` in the running bundle**, not `app.setName()`. A dev run says "Electron" because it runs Electron's own bundle; the packaged app is always right. `scripts/brand-dev-electron.js` patches the dev copy from `postinstall`.
- **A custom application menu must keep `role: 'editMenu'` and `role: 'viewMenu'`.** Electron's default menu is what provides Cmd/Ctrl+C/V/X/A in the command input and Toggle Developer Tools; calling `setApplicationMenu` drops both silently. Pinned by a test.
- **No dev server.** The renderer is always a `file://` URL, built by Vite. `sandbox: false` is conditional on this window only ever loading local, first-party content, and a window that can point at `http://localhost` is a window that can point anywhere.
- **Electron forbids external ArrayBuffers** (`napi_status 22`). C-owned memory cannot be aliased from JS; access is an explicit copy, and the names say so.
- **Determinism rules live in `design-lab-model.md` §5.** Fixed summation order, no `-ffast-math`, and *where two routes reach the same value, make them agree on purpose*. Canonical numbering for anything that assigns identities.

## Working habits that have paid off here

- **Measure before optimising, and before believing.** `merge` was 114× slower than necessary and nothing in the code looked wrong. The default `minMag` was tuned on synthetic images and missed a third of the real ones.
- **Assert properties, not current output.** A test that records what the code produces cannot tell you the code is wrong.
- **A check that runs in one place can pass for the wrong reason.** An implicit `posix_memalign` declaration warned on every Linux build for weeks and never once on macOS.
- **A green build can ship a broken feature.** The generator page calls pt-lab from plain JS across a Vite alias, so a sibling checkout one commit behind builds, packages, launches and smoke-tests clean, then throws on use — two CI jobs did exactly that. `build:generate` now asserts every `lab.<method>()` the page calls is *defined* in the bundle, not merely called in it.
- **Read what `git add -A` staged.** A renderer build once wrote itself to the project root — 92 files, 13 MB — and `git add -A` committed 83 of them under a stat line reading "105 files changed, 70315 insertions(+)". `/*.js` is ignored now and `test/repo.js` fails loudly if any reappear, because an ignored stray accumulates silently, which is worse.
- **Layout is not behaviour.** `verify:package` checked that the right files were in the artifact and passed on every release while the packaged app was dead on launch — the preload required `scripts/png.js`, which was never in `files:`, so `window.lab` never existed. `smoke:package` starts the real artifact and asks whether it works. Anything the preload or main process `require`s at runtime must be in `electron-builder.yml`.
- **Read CI logs for warnings, not only errors.** That is how the above survived three green checkmarks.
- **Cost is quadratic in segment count, not resolution.** A megapixel of pixel work is ~30 ms; a busy scene is what hurts.
- **A scoring table reports a number whether or not it is right.** Both defects in the ground-truth machinery were invisible in the tally and obvious in one overlay image — as were the two fixtures before them that nobody had looked at. `npm run overlay` exists for that, and it is not a convenience.
- **Check that a fix helped.** A visibility tolerance was "improved" against a degenerate view and made the measurement strictly worse everywhere else.

## Open questions

In `design-lab-model.md` §11 — whether `load` should default to `as=linear`;
whether higher-precision decoding is worth a native decoder; whether
`pt-lab-workspace` writes gamma-encoded or linear PNGs, which matters because
every image in `assets/` declares nothing and the lab assumes sRGB by
convention; and whether the corner thresholds measured over twenty-four views
of a cube hold on anything that is not a cube. The AOV passes are exported and
nothing yet consumes them — classifying an unmatched detection as texture,
shading or noise is the next thing they are for.
