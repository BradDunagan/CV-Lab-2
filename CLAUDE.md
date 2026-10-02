# cv-lab-2

An Electron + native C computer-vision lab. Images in, described geometry out —
straight edges and curved ones, both with sub-pixel endpoints, and corner
hypotheses carrying their own uncertainty.

Two requirements shape almost every decision: it handles **non-8-bit data**, and
every result is **reproducible** from a replayable log.

## Read these before changing anything

| | |
|---|---|
| `docs/cv-lab-users-manual.md` | how to **use** it — every operation and parameter, the workflows, what the outputs mean, what it deliberately does not do |
| `docs/design-lab-model.md` | the model — slots, operations, the command language, provenance, determinism. Written *before* implementation and corrected where reality disagreed |
| `docs/electron-guide.md` | builds, CI, packaging, signing, and the Electron constraints that shaped the architecture. Written *after* doing the work |
| `docs/glossary.md` | terms used in all of them, explained from scratch |
| `docs/git-and-github.md` | the branch/CI/merge operations every change here goes through, and why this repository does them that way |
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
src/lab/ops.js       the twenty-three operations themselves: inputs, params,
                     defaults, and the kernel each one binds to
src/lab/registry.js  the schema they are declared against — validation,
                     error messages, provenance records
src/lab/parser.js    the command language
src/lab/session.js   slots, execution, the log, the provenance graph
src/lab/corners.js   corner hypotheses (pure JS — no pixels involved)
src/lab/groundtruth.js   reads a renderer's ground truth in as features
src/lab/match.js     scores detected features against it (pure JS)
src/lab/explain.js   what put each edge in the picture — reads the AOV
                     passes: occlusion, crease, texture, or shading
src/lab/gapsweep.js  the image gap between two parts, detected against
                     true, one row per step of a gap sweep (pure JS)
src/lab/pairs.js     two close edges placed again, jointly, against the
                     unblurred image -- and found, where the detector
                     reported the two as one segment (pure JS)
scripts/lab-cli.js   headless batch runner: a pipeline over many images
scripts/generate-cli.js  drives pt-lab to render varied images (needs a GPU)
scripts/score.js     tallies match records: precision, recall, and which
                     corner field actually discriminates
scripts/overlay.js   draws ground truth and detections over an image — every
                     defect in the scoring machinery was found this way
scripts/gap-sweep.js steps one part toward another, renders each step, runs
                     the lab over them and tabulates the gap -- from one
                     view, or a grid of them (needs a GPU)
pt-lab/              the path tracer + scene editor library, TypeScript, moved in
                     from its own repository — see pt-lab/README.md
src/generate/        the generator: page (bundled separately) + main-process
                     driver shared by the CLI and the app's Generate frame;
                     also the Scene Editor page (pt-lab's view and a
                     `__editor` API, saving to scenes/ through its own
                     sandboxed preload); its controls are a paneless column,
                     src/renderer/panes/editor-controls.svelte.js
src/menu.js          the application menu — global commands live here, not in the UI
src/preload.js       owns the session and every buffer handle
src/renderer/        Svelte 5 + paneless; no require, no fs, no pixels
dist-renderer/       what Vite builds from it — this is what Electron loads
test/                eighteen suites; seventeen run under plain node
pipelines/           .lab scripts for the batch runner
```

## Commands

Node 22.12+ — see `.nvmrc`. `scripts/check-node.js` runs ahead of install,
build and test, because the requirement used to surface as a `styleText`
export error from inside Vite's plugin chain.

```bash
npm test                # everything — eighteen suites, ~525 tests
npm run lint:native     # strict -Wall -Wextra -pedantic on the pure-C sources
npm start               # build the renderer, then launch the app
npm run lab -- --help   # run a pipeline over images, headless
npm run score -- results/           # found, against what is really there
npm run overlay -- <img> results/   # ...and the same thing as a picture
npm run gap-sweep -- --name gap-1   # a part closing on another, down to contact
                                    # (--yaw, --elevation: from a grid of views)
npm run build:native    # compile the addon
npm run build:renderer  # Vite build of src/renderer/ into dist-renderer/
npm run check:pt-lab    # type-check pt-lab/ — the build strips types unchecked
npm run dev:renderer    # the same, in watch mode
npm run build:generate  # the generator bundle — rerun whenever pt-lab's source
                        # changes; a stale one is refused rather than run
npm run package         # installers; builds the generator INTO the app
npm run verify:package  # the artifact's layout
npm run smoke:package   # launch it and check it actually works
```

## Constraints that are not negotiable without a reason

- **Node-API, never NAN.** One binary works under both Node and Electron. Verified, not assumed.
- **Image generation ships in the app.** It is not a developer tool: varying lighting and pose to test a pipeline against is the lab's core loop, so `npm run package` builds `dist-generate/` into the `app.asar`. pt-lab's source lives in `pt-lab/` and its dependencies are devDependencies — the bundle carries the tracer, the model and the environment, so none is needed at run time. Needs a GPU; adds ~17 MB.
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
- **A green build can ship a broken feature.** The generator page calls pt-lab from plain JS across a Vite alias, so a sibling checkout one commit behind built, packaged, launched and smoke-tested clean, then threw on use — two CI jobs did exactly that. pt-lab lives in this repository now, which ends that case, but not the class: `build:generate` still asserts every `lab.<method>()` the pages call is *defined* in the bundle, because nothing type-checks the callers.
- **Read what `git add -A` staged.** A renderer build once wrote itself to the project root — 92 files, 13 MB — and `git add -A` committed 83 of them under a stat line reading "105 files changed, 70315 insertions(+)". `/*.js` is ignored now and `test/repo.js` fails loudly if any reappear, because an ignored stray accumulates silently, which is worse.
- **A UI change is checked by using it.** `.claude/skills/run-cv-lab/` launches
  the app with debug ports and drives it with real clicks and keys -- open a
  pane from the menu, set a field by its label, press a button, screenshot,
  read the result. A test that sets a control's value cannot tell you a person
  could.
- **Layout is not behaviour.** `verify:package` checked that the right files were in the artifact and passed on every release while the packaged app was dead on launch — the preload required `scripts/png.js`, which was never in `files:`, so `window.lab` never existed. `smoke:package` starts the real artifact and asks whether it works. Anything the preload or main process `require`s at runtime must be in `electron-builder.yml`.
- **Read CI logs for warnings, not only errors.** That is how the above survived three green checkmarks.
- **Cost is quadratic in segment count, not resolution.** A megapixel of pixel work is ~30 ms; a busy scene is what hurts.
- **A scoring table reports a number whether or not it is right.** Both defects in the ground-truth machinery were invisible in the tally and obvious in one overlay image — as were the two fixtures before them that nobody had looked at. `npm run overlay` exists for that, and it is not a convenience.
- **Check that a fix helped.** A visibility tolerance was "improved" against a degenerate view and made the measurement strictly worse everywhere else.

## Open questions

In `design-lab-model.md` §11 — whether `load` should default to `as=linear`;
whether higher-precision decoding is worth a native decoder.

Whether pt-lab writes gamma-encoded or linear PNGs is answered: **neither.**
Its beauty renders are ACES-tone-mapped, then sRGB-encoded, and the lab undoes
only the sRGB. The curve moved edges up to ~0.2 px off the geometry, all of
the table edge's share of the gap sweep's bias. `npm run generate --
--tone-mapping linear` is for measurement, and `gap-sweep` defaults to it
(`design-lab-model.md` §5). Still open from the same work:

- the gap cube's edge, displaced up to ~0.3 px even in linear renders. It is
  not gloss (a matte red cube keeps it), and not "toward the darker side". It
  tracks the face against the gap behind it. Closed unexplained by decision
  (`design-lab-model.md` §5): the 1-2 mm blur push-apart is 5-10x larger;
- undoing a real camera's response curve on load.

The AOV passes are consumed now: `explain` says what put each detection in the
picture, and **111 of 123 invented segments turned out to be shading** — the
detector finding a shadow boundary, which is a real image edge belonging to the
light rather than to the object. That answers the question §11 asked and
sharpens the one about corner thresholds: they hold on a bare cube with an
18.8× margin and break on the same cube once a table, a ball and a lit room are
added, so it is the clutter rather than the subject.

What it opened instead: **corner precision on a multi-object scene measures the
truth model as much as the detector.** Half the invented corners that sat on
real depth steps were two real occluding contours crossing where no mesh vertex
exists — a T-junction, which ground truth cannot represent because it lists
vertices. Whether it should is unclear: T-junctions are view-dependent and an
edge is not.

The helmet has now been run through the same apparatus, and it corrected this
repository rather than the detector. Four places here said its edges were
"overwhelmingly paint"; **texture is 8%**, and 61% of what the detector finds on
it matches real geometry. What makes it a poor fixture is the truth set —
~3,000 visible edges a view against ~160 detections.

The 73% of invented segments that looked like real depth steps were **the
measurement, not the scene**. Sweeping `explain`'s sample offset showed the
occlusion share tracking it on every subject, 57% → 92%, and a per-detection
test settled it: the depth difference scales with the sampling distance, which
is what a surface receding from the camera does and what a step does not.
`explain` v2 subtracts what a continuous surface accounts for and tests the
residual; invented occlusion falls 282 → 88 and all 199 verified real steps
keep it. Slant itself is recorded and deliberately not thresholded — it is 64°
under both populations, because both live at a silhouette.

Still open from the same run: **ground-truth visibility is computed at the
render size**, so recall is not comparable across resolutions.

The gap sweep's largest error is answered: **two edges a few pixels apart
displace each other in the blurred image**, +1.2 px on a 2.3 px gap, and
`fitPairs` places them again against the unblurred one to within 0.1
(`design-lab-model.md` §5, "A fifth"). The aperture a pixel gathers light over
has to be measured for that, on the image's lone segments; assumed, or fitted
per pair, it gives confident wrong answers. Still open from it:

- **under about a pixel and a half the strip's level must be supplied**, and
  nothing carries it from one frame of an approach to the next. Holding it is
  sound: at 2048 px the level reads 0.119, 0.122, 0.116 and 0.104 at 5, 2, 1
  and 0.5 mm. And **more pixels do the whole job**: at 2048 px the 1 mm and
  0.5 mm gaps are ordinary pairs, read to −0.011 and −0.017 mm. `findPairs`
  finds the 1 mm gap (1.16 px) inside the single segment the detector leaves,
  and reads it 0.25–0.28 px short with the level fitted, 0.14–0.16 with it
  held;
- **0.5 mm and contact are not told apart** at 512 px, and contact is told
  from nothing at any size;
- **the strip is not flat.** It is darkest against the Cube, in the same
  proportion at every gap, and the model fits one level to it. Whether that is
  the remaining −0.05 to −0.11 px is untested;
- **`findPairs`'s gain threshold rests on two renders of one scene.**
  It is a calibration, and the place a real camera is most likely to move.

**Where the camera is decides how many pixels a millimetre is**, and that
decides everything else. Over 28 views of the gap sweep the refit's error is
the same −0.2 to −0.3 px wherever it reads at all, and it reads wherever the
gap is over about 1.1 px in the image. Pixels per millimetre of a vertical gap
runs from 1.22 square-on and level to 0.11 at 70° round and 75° up
(`design-lab-model.md` §5, "A seventh"). Still open from it:

- **an edge pair measures one direction.** Sliding the part along the edge
  changes nothing in any view. Sideways and in-and-out position need a fixture
  with corners, or two edge pairs at an angle;
- **combining views.** The grid is a multi-view data set and nothing uses it
  as one yet: a view where the gap is wide in pixels could supply the strip's
  level, or the gap itself, to a view where it is narrow;
- **the −0.2 px.** It is in every view, so it is the fit or the renderer and
  not the geometry.

The aperture was the lower quartile of the lone segments' for a day and is the
median now: over sixteen frames from one renderer the quartile ranged 1.06 to
1.31 and the median 1.31 to 1.39. The claim and the correction are both in
`design-lab-model.md` §5.
