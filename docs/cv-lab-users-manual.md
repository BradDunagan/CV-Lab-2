# cv-lab-2: User's Manual

How to operate the lab. What every operation does, what every parameter is for,
how to get an image in and geometry out, and what the numbers mean once you
have them.

The other three documents answer different questions, and this one deliberately
does not repeat them:

| | |
|---|---|
| [`design-lab-model.md`](design-lab-model.md) | **why** it is built this way — and the places where that document was wrong and got corrected |
| [`electron-guide.md`](electron-guide.md) | building, CI, packaging, signing |
| [`glossary.md`](glossary.md) | every term here, explained from scratch |

Section references in this file name their document, because all four number
their sections from 1.

**Two things shape everything below.** The lab handles **non-8-bit data**, so
nothing is a `<canvas>` and nothing is clamped to 0–255 between stages. And
every result is **reproducible from a replayable log**, so every command you
run — typed, clicked or scripted — is recorded with its parameters resolved and
its output content-hashed.

---

## 1. Getting started

Node 22.12 or later; `.nvmrc` names it. If `npm` fails inside Vite's plugin
chain with `does not provide an export named 'styleText'`, you are on an older
Node — `scripts/check-node.js` runs ahead of install, build and test to say so
in plain words instead.

```bash
npm install            # builds the native addon
npm start              # build the renderer, then launch the app
npm test               # twelve suites, ~334 tests
```

Two ways in, and they run the same code:

- **The application** — type commands, see the results as tiles, hover to read
  pixel values.
- **`npm run lab`** — the same pipeline over many images, headless.

The interface does not call operations directly. It composes a command string,
puts it in the log, and executes that. So anything you can do by clicking, you
can do by typing, and the two cannot drift.

---

## 2. The command language

Deliberately tiny. The whole grammar:

```
statement := [ IDENT '=' ] IDENT '(' [ arg { ',' arg } ] ')'
arg       := value | IDENT '=' value
value     := IDENT | NUMBER | STRING | 'true' | 'false'
```

In practice:

```lab
A = load("samples/board.png", as=linear)
B = gaussian(A, sigma=1.4)
C = sobel(B, axis=mag)
D = threshold(C, t=0.2)
stats(C)
// comments, so scripts document themselves
```

The name on the left is a **slot**. Slots are created by assignment; there is
no fixed number and no declaration. Positional arguments come first and are
matched to the operation's inputs in order; everything else is `key=value` and
may appear in any order.

**Absent on purpose:** control flow, arithmetic, user-defined functions, and
variables that are not slots. If you need a loop, drive the lab from a real
scripting engine (`npm run lab` does exactly this) rather than expecting the
language to grow one.

### Slots are versioned; the log is not rewritten

`A = gaussian(A, sigma=2)` does not modify `A`. It appends an entry producing
`A#2` and rebinds the name. `A#1` still exists as far as the log is concerned,
and anything that referenced it still means what it meant.

The analogy that fits: **log entries are commits, slot names are refs.** Names
move; history does not. This is why the log records `(slot, version)` pairs
rather than bare names — a chain built from bare names would go ambiguous the
moment a slot was reassigned.

### What gets recorded

Not the text you typed. The **resolved** record:

```
you type   B = gaussian(A, sigma=1.4)
log holds  gaussian(A#1, sigma=1.4)   [v1]  →  B#1, sha256:31ab…
```

Defaults are filled in at record time and parameters are put in canonical
order. If a default changes in a later version, your old log still means what
it meant. This is the single most important rule in the whole design, and it is
why `groundTruth(path="x.gt.json")` reads back as
`groundTruth(kind=both, path="x.gt.json")`.

A command that is **refused appends nothing**. A failed run leaves no trace of
having tried.

---

## 3. Operation reference

Eighteen operations. Every one is a single entry in `src/lab/registry.js`, which
is also what validates your arguments and generates the error messages.

Notation: `[1]` means the input must have one channel; `linear` means it demands
linear values and will refuse sRGB ones (§9).

### Sources — they take no slot

#### `load(path, from, as)` → 3-channel f32

Decode an image file.

| parameter | default | what it does |
|---|---|---|
| `path` | `""` | the file |
| `from` | `srgb` | what the stored bytes **mean** |
| `as` | `srgb` | what the buffer should **hold** |

The two are different questions and both matter. Most files declare nothing and
the universal convention is sRGB, which is the default. A file that *does*
declare, and disagrees, is refused rather than silently curve-corrected:

```
load: the file declares linear samples (gAMA 100000 (gamma 1.0)),
      but from=srgb. Pass from=linear.
```

Only PNG is checked, via `cICP`/`iCCP`/`sRGB`/`gAMA` in specification
precedence order. JPEG and WebP fall back to the convention.

**Alpha is dropped**, always. The lab has no compositing model.

Only works in a renderer: `load` borrows Chromium's decoder, which is why
`npm run lab` runs under Electron with the window hidden, and why under plain
`node` the operation reports itself unimplemented instead of throwing when
called.

#### `pattern(kind, width, height, channels, value)` → f32, linear

A synthetic image needing no file. Useful for testing a pipeline and for
reproducing a bug without shipping a picture.

| parameter | default | range |
|---|---|---|
| `kind` | `ramp` | `ramp` \| `checker` \| `impulse` \| `constant` |
| `width`, `height` | 64 | 1 … 1048576 |
| `channels` | 1 | 1 … 4 |
| `value` | 0.5 | used by `constant` |

`checker` draws **8-pixel blocks** regardless of size. That number matters: at
the default `minPixels=8`, `segments` finds *zero* edges on a blurred
checkerboard, because no run of one survives blur and thinning. It is a
frequent way to conclude a pipeline is broken when it is not.

#### `groundTruth(path, kind)` → features

Read a renderer's ground truth — where the edges really are — as `gt-edge` and
`gt-vertex` records. See §7.

| parameter | default | |
|---|---|---|
| `path` | `""` | a `.gt.json` written by `npm run generate -- --truth` |
| `kind` | `both` | `edges` \| `vertices` \| `both` |

### Colour space

#### `toLinear(src)` → same shape, linear
#### `toSrgb(src)` → same shape, srgb

Apply or undo the sRGB transfer function. Exact 256-entry lookups when the
source came from 8-bit, so no per-pixel `pow` and no approximation.

These exist as real operations, rather than as automatic conversions, because
an automatic one would insert processing that never appears in the log — and
the log explaining the result is the whole claim.

### Pixels

#### `gray(src[3] linear)` → 1-channel f32, linear

Luminance: `0.2126 R + 0.7152 G + 0.0722 B`.

Those coefficients are valid **only on linear values**. Applied to sRGB values
they produce *luma*, a different quantity, and this operation refuses rather
than computing it and calling it luminance. That refusal exists because the
first version of `gray` shipped with the requirement declared and checked
nowhere.

#### `gaussian(src[1,3] linear, sigma)` → same shape

Separable Gaussian blur. `sigma` 0.1 – 100, default **1.4** (Canny's usual
starting point).

`linear` because blur mixes pixels, and mixing gamma-encoded values averages in
the wrong space and comes out too dark.

`preview` is a non-semantic parameter: it is excluded from the log and from any
hash, so toggling it never invalidates a result.

#### `sobel(src[1], axis)` → 1-channel f32, no colour space

First derivative. `axis` is `x` \| `y` \| **`mag`**.

`x` and `y` are **signed** — negative on half of every edge. `mag` is
`√(gx² + gy²)` and is never negative. Passing a signed derivative where a
magnitude belongs is the single most common mistake with this pipeline, because
everything downstream succeeds and produces nothing (§10).

Sobel on sRGB is *different*, not wrong — it emphasises edges in dark regions
more. Which is why the space is recorded rather than enforced here.

#### `orient(gx, gy, range)` → 1-channel f32

Gradient direction in radians, perpendicular to the edge. `range` is `signed`
(−π, π] or `unsigned` [0, π) — the latter when a gradient pointing the opposite
way is the same edge seen from its other side.

Display it with the **cyclic** colormap; any other map puts a false seam where
the angle wraps.

#### `nms(mag, gx, gy)` → 1-channel f32

Non-maximum suppression: thin gradient ridges to one pixel by keeping a pixel
only if it is at least as large as its two neighbours **along the gradient
direction**.

The first input is the **magnitude**. It drops everything ≤ 0, so a signed
derivative loses half its edges silently.

#### `threshold(src[1], t, invert)` → 1-channel i32 mask

1 where the input exceeds `t`, else 0. Ordering-only, so colour space genuinely
does not matter.

#### `hysteresis(src[1], low, high)` → 1-channel i32

Keep a weak edge if — and only if — it connects to a strong one. `low` 0.05,
`high` 0.15 by default; a 1:2 or 1:3 ratio is a reasonable starting point and
the right values depend entirely on the image, which is what `stats` is for.

`low` must not exceed `high`; the lab refuses rather than reinterpreting.

8-connected, and it does **not** wrap at the image border — the last pixel of a
row does not touch the first pixel of the next.

#### `stats(src[1,3])` → scalars, binds to no slot

`min`, `max`, `mean`, `stddev`, `count`. Run it on a thinned magnitude before
choosing `minMag`; run it on anything before choosing a threshold.

### Geometry

#### `segments(mag, gx, gy, …)` → 1-channel i32 label map

Grow straight edges from the gradient field. One label per segment, 0 for
background.

| parameter | default | what it does |
|---|---|---|
| `angleTol` | 22.5° | how far a pixel's gradient may differ from the region's before it is a different edge |
| `minMag` | **0.005** | pixels weaker than this are not edges at all |
| `maxResidual` | 1.0 px | how far a pixel may sit off the fitted line before the region stops being straight |
| `minPixels` | 8 | shorter runs are discarded |
| `polarity` | `signed` | whether a gradient pointing the opposite way is the same edge |

**Feed it a thinned magnitude** — `nms` output, not a raw gradient. A raw ridge
is several pixels wide and no line fits a wide band within a one-pixel
tolerance, so the regions fragment.

`minMag` defaults to 0.005 rather than something rounder because it was tuned
against a real render: a hard 0→1 step gives gradient magnitudes near 0.5, and
a *shaded cube* peaks at **0.0585** after thinning — an order of magnitude
weaker. Run `stats` on your `nms` output before assuming any value.

#### `merge(src[1], gap, maxResidual, angleTol)` → i32 label map

Join segments that are collinear and nearly touching. `gap` 6 px,
`maxResidual` 1.0 px, `angleTol` 15°.

A separate operation rather than a flag on `segments`, so you can see what it
joined by comparing the two label maps.

#### `fit(src[1] i32)` → features (`edge-segment`)

The first operation whose output is not pixels. A label map says *which* edge a
pixel belongs to; this says what each edge **is**.

Per segment: `id`, `pixels`, `x0 y0`, `x1 y1`, `length`, `angle`, `residual`,
`rms`, and the centroid `cx cy`.

Two conventions are easy to read wrongly:

**`angle` is measured from horizontal, anticlockwise, in image coordinates —
where y increases DOWNWARD.** So the sense is inverted from graph paper:

| angle | the line runs | on screen |
|---|---|---|
| 0° | right, same row | horizontal |
| 45° | right and down | **descending** to the right |
| 90° | down a column | vertical |
| 135° | right and up | **ascending** to the right |

Reported in [0, 180), because a line has no direction.

**`residual` is the largest PERPENDICULAR distance** from any of the segment's
pixel centres to its fitted line, in pixels. Perpendicular is the point — that
is total least squares, which is rotation-invariant, rather than ordinary least
squares, which measures vertically and misbehaves on near-vertical edges. It is
a maximum, so it reads as a guarantee: no pixel lies further out than this.

Calibration, from constructed cases:

| shape | worst residual |
|---|---|
| a perfectly straight run | 0.000 |
| a single one-pixel step | 0.461 |
| a one-pixel zigzag | 0.564 |
| a 45° bend halfway along | 2.242 |

So sub-pixel values are the noise of drawing a line onto a grid, and anything
above about 1 is not a line. That is what `maxResidual` gates.

`rms` is reported alongside because error propagation needs it: the maximum is
a guarantee about the worst pixel, the RMS is what `corners` extrapolates with.

**Endpoints are projected onto the fitted line**, not reported as the extreme
pixels. That is where sub-pixel accuracy comes from — the line is an average
over every pixel in the segment, so it localises better than any single pixel
centre can.

#### `corners(src features, …)` → features (`edge-corner`)

Intersect fitted segments pairwise. Features in, features out.

| parameter | default | what it does |
|---|---|---|
| `minAngle` | 15° | near-parallel lines intersect far away and wrongly; error goes as 1/sin(angle) |
| `maxReachRatio` | 2 | how far past its own length a segment may be extended, as a ratio — scale-free, because reaching 5 px off a 60 px segment is cheap and off a 7 px segment is not |
| `cluster` | 3 px | intersections closer than this are one corner |

**It deliberately does not decide which intersections are real.** Real edges
systematically stop short of their corners — blur rounds the vertex, non-maximum
suppression deletes junction pixels outright, and weak ends fall below `minMag`
— so a gap between a segment's end and a true corner is the *normal* case and
any fixed pixel threshold is wrong for half of any image.

So each candidate carries its evidence instead:

| field | what it measures |
|---|---|
| `support` | how many segment pairs agree at this location |
| `endpointGap` | how far apart the two edges' **nearest ends** actually are |
| `reach` | how far past its own end each line had to be **extended**. Negative means they genuinely cross |
| `sigma` | propagated positional uncertainty, in pixels |
| `angle` | the angle between the two lines |

Which of those you should threshold on is measured, not guessed — see §7.

#### `match(src features, truth features, …)` → features (`edge-match`)

Score detected features against ground truth. Dispatches on what the *detected*
records say they are: `edge-segment` goes to the ground truth's edges,
`edge-corner` to its vertices.

| parameter | default | what it does |
|---|---|---|
| `maxDistance` | 3 px | how close counts as the same thing |
| `maxAngle` | 20° | how differently a matched segment may run |
| `minVisible` | 0.5 | which ground-truth edges the detector is answerable for |
| `minAngle` | 30° | which ground-truth vertices count as corners rather than polyline bends |

Refuses two feature lists measured in different images, because scoring a
512-pixel run against 256-pixel truth produces plausible numbers rather than an
error.

---

## 4. The application

`npm start`.

### Panes

A tiling workspace. **Panes → New Slot Pane** (⌘N) adds a tile; **New Log Pane**
adds the session log; **Generate Images…** (⌘G) opens the generator frame.

A slot pane shows one slot. Click the slot name in its header to bind a
different one. Its header reads `A#2  512×512×1 f32 linear` — name, version,
dimensions, channels, dtype and colour space.

### View controls

Per tile, and **non-destructive** — they change how a buffer is drawn, never
what it contains. The next operation in the pipeline sees the real numbers.

| control | options |
|---|---|
| view | `image`, `histogram` |
| colormap | `gray`, `viridis`, `turbo`, `diverging`, `categorical`, `cyclic` |
| range | `auto`, `percentile`, `symmetric` |
| curve | `linear`, `log`, `abs`, `sqrt` |
| channel | `all`, or one |

**The defaults are chosen by data kind, and they are what make a result
readable rather than a grey smear:**

| data | default |
|---|---|
| `i32` label map | categorical, auto — never interpolated, because a label is a name and the average of region 3 and region 9 is not region 6 |
| `space: none` (gradients, signed) | **diverging + symmetric about zero** — negatives one hue, positives the other, zero neutral |
| everything else | gray, auto |

Two of these are worth knowing about:

- **`auto` range makes two tiles incomparable.** The mapping follows each
  buffer's own extremes, so the same colour means different values in each. One
  outlier pixel also flattens everything else. `percentile` is immune to the
  outlier and still adaptive.
- **`log` is not always stronger than `sqrt`.** That ordering only holds once
  data spans orders of magnitude. On a 0–1 range, `log1p` is very nearly linear
  and `sqrt` lifts small values *more*. Pinned by a test, because the opposite
  is the natural assumption.

**View → Scaling** picks `smooth`, `pixels` or `actual`; **Draw fits over
tiles** overlays feature geometry; **Reset View** (⌘0) returns pan and zoom.

### The probe

Hover anywhere and read `(x, y)` with the value in **every** slot at once:

```
(1204, 883)   A: 0.784   B: 0.612   C: -0.204   D: 1
```

This is the most useful debugging affordance in the tool, and it exists only
because all slots are uniform and share a coordinate space. Pan and zoom are
synchronised across tiles for the same reason.

### The command bar

Type a command and press Enter. **Up** and **Down** walk the history, and
**Run** does the same as Enter.

Beside it is an **operation menu**. Picking a name does not run anything — it
inserts a template with every parameter written out at its default, assigned to
the next free slot:

```
D = hysteresis(A, low=0.05, high=0.15)
```

Those are the *fully resolved* defaults, exactly as the log will record them, so
what you are handed is what provenance will say happened. Operations with no
kernel in this build are listed and disabled rather than hidden — `load` shows
as `load (no kernel)` under plain `node`.

This is the whole of the "the GUI writes commands" principle in one control, and
it is how you learn the language: pick an operation, see the command, edit the
numbers.

### File menu

**Open Image…** (⌘O) composes a `load(...)` and runs it. **Save Session…**
(⌘S) writes the log. **Discard Session…** clears everything.

---

## 5. Running it without the app

```bash
npm run lab -- --script pipelines/geometry.lab --as linear --out results/ generated/*.png
```

| option | |
|---|---|
| `--script <file>` | commands to run against each image, one per line |
| `--image <png>` | repeatable; or list them bare |
| `--out <dir>` | write `<name>.session.json` and `<name>.features.json` per image |
| `--from srgb\|linear` | what the file's samples mean (default `srgb`) |
| `--as srgb\|linear` | what the buffer should hold (default `srgb`) |
| `--slot <name>` | slot the image loads into (default `A`) |
| `--truth <dir>` | ground truth to score against: `<dir>/<name>.gt.json` |
| `--truth-slot <n>` | slot it loads into (default `T`) |
| `--quiet` | only report failures |

Each image gets a **fresh session**, because slot names repeat and a leftover
binding would feed one image's buffer into the next image's pipeline. The
runner prepends the load — and, with `--truth`, the ground-truth load — then
runs your script:

```
A = load("<image>", from=<from>, as=<as>)
T = groundTruth("<truth-dir>/<name>.gt.json")
```

so write your script against `A` and `T`.

Exit codes mean something: **0** all passed, **1** a pipeline failed, **2** a
usage error.

It runs under Electron with no window, for one reason only: `load` borrows
Chromium's decoder. It drives the same `window.lab` bridge the interface does,
so the batch path cannot drift from what the app does.

---

## 6. Generating images

Needs a GPU and the sibling `pt-lab-workspace` checkout. Not part of `npm test`.

```bash
npm run build:generate                                    # once
npm run generate -- --out generated/ --scene cube --truth --aovs
```

| option | default | |
|---|---|---|
| `--out <dir>` | — | required |
| `--scene <name>` | `helmet` | `helmet` \| `cube` |
| `--size <px>` | 512 | square |
| `--samples <n>` | 96 | path-tracing samples per image |
| `--positions <n>` | 3 | camera positions |
| `--lighting <n>` | 2 | light intensities |
| `--room <kind>` | the scene's own | `room` \| `room-emissive` \| `room-arealight` \| `none` |
| `--aovs` | off | also write depth, normal and albedo passes |
| `--truth` | off | also write `<name>.gt.json` |
| `--crease-angle <d>` | 20° | how sharp a fold counts as an edge |
| `--denoise` | off | run OIDN over each export |
| `--show` | off | show pt-lab's window and watch it converge |
| `--dry-run` | off | print the sweep, render nothing |

About **20 s per image**. `--dry-run` before committing several minutes.

The same thing from inside the app: **Panes → Generate Images…** (⌘G).

**The two scenes are for different questions.** `helmet` is a dense textured
mesh whose image edges are overwhelmingly paint — a fine detector workout and a
poor thing to grade against geometry. `cube` is a 10 cm cube on a table with a
ball beside it: twelve edges and eight vertices in known places, nine and seven
of them visible from a general viewpoint.

**`--room none`** uses pt-lab's photographic HDR environment. It looks better
and is a poor CV fixture — the blurred background and textured tabletop
dominate the edge count, 446 segments against 156 for the same object in a
room.

**`--denoise` is off**, matching pt-lab's own default, which means every image
this generator has produced carries the raw path-traced noise floor. Grain on a
flat wall fires an edge detector as readily as a real edge. It is left off so
that turning it on does not silently move numbers already recorded — turn it on
deliberately, and say so when reporting.

Beauty renders are **tagged sRGB** by pt-lab, so `load` confirms the encoding
rather than assuming it. The AOV passes are **untagged on purpose** — they carry
linear code values, not colour — and must be read `from=linear`.

### How the generator actually works

Worth knowing before you change anything here, and worth knowing anyway,
because the obvious guesses are all wrong. There is **no browser**, no
localhost, no server and no HTTP. pt-lab is compiled into a page that cv-lab-2
loads into a hidden Chromium renderer inside its own process tree, and drives.

```
┌─ cv-lab-2 main process (Node) ─────────────────────────────────────┐
│                                                                    │
│  scripts/generate-cli.js        src/main.js ← IPC ← Generate pane  │
│                    └──────┬───────────┘                            │
│                    src/generate/driver.js                          │
│                      · registers gen://                            │
│                      · owns the BrowserWindow                      │
│                      · intercepts will-download                    │
│                      · computes the sweep (plan)                   │
└───────────────────────────┬────────────────────────────────────────┘
                            │  win.webContents.executeJavaScript("__gen.…")
                            │  ↑ return values (structured clone)
┌───────────────────────────▼────────────────────────────────────────┐
│  generator renderer — a hidden BrowserWindow, gen://lab/index.html │
│                                                                    │
│    dist-generate/generate.js  =  src/generate/main.js              │
│                                  + pt-lab (three.js, OIDN, WebGL)  │
│    globalThis.__gen = { init, applyScene, camera, lighting,        │
│                         quality, denoise, render, aovs,            │
│                         groundTruth, status, objects, transform }  │
└────────────────────────────────────────────────────────────────────┘
                            │  a.click() on a blob: URL → download
                            ▼
                     generated/*.png, generated/aov/*.png
```

**pt-lab is a Vite alias, not a dependency.** `vite.generate.config.mjs` points
`'pt-lab'` at `../pt-lab-workspace/packages/pt-lab/src/index.ts` and bundles its
*source*. It is deliberately absent from `package.json`, because a `file:`
dependency must resolve at **install** time even when nothing imports it — so
adding it would break `npm ci` anywhere the sibling checkout is missing, CI
included. Only that one config knows pt-lab exists, and only
`npm run build:generate` reads it. That is also why this is a separate bundle:
three.js and an OIDN WASM blob have no business in the app's renderer, and CI
runners have software GL only, so building it there would cost minutes for an
artifact nobody can use.

**Why a custom `gen://` scheme rather than `file://`.** three.js's loaders fetch
the glTF model and the HDR environment, and **Chromium refuses `fetch()` on
`file://`** — the first attempt died with a bare "Failed to fetch". `gen://` is
registered before app-ready with `supportFetchAPI: true`, which gives a real
origin in-process: no TCP port, nothing listening. `gen://lab/` serves the built
page and `gen://lab/assets/` serves pt-lab's own assets straight out of the
sibling checkout, which is where its default URLs already point.

**Two directions, both deliberately small.** Options go in through
`executeJavaScript` against a named global. Results come back two ways, and the
split is on purpose:

- **Images come back as downloads.** pt-lab delivers an export by triggering
  one, and that is worth keeping rather than reading the canvas here, because
  `exportPNG` also converges to the sample target, denoises, downscales and tags
  the PNG as sRGB. The driver catches `will-download` and chooses the save path.
- **Ground truth comes back as a return value.** It is small, it is data rather
  than an image, and `maxDepth` travels with it — so nothing has to parse a
  float back out of a filename.

**No pixels cross the boundary.** Renders go to disk and come back through
`load` like any other file, which is the same rule the lab follows internally
(`design-lab-model.md` §8).

Two consequences worth knowing:

**The window is real, just hidden.** `--show`, or *show the render window* in
the Generate pane, makes it visible and you watch pt-lab path-trace. Nothing
about the output changes — `exportPNG` renders offscreen at the requested size
either way. It was hidden by default for no better reason than not wanting a
window stealing focus for minutes, and the cost of that was nobody looking at
the images for a long time.

**The app never hosts the tracer.** The Generate pane sends options over IPC and
displays progress; the main process runs pt-lab in its own window. That boundary
is why growing the frame is cheap — every new pt-lab control is one field in the
pane and one key in the options object, and nothing about the plumbing changes.
`--scene`, `--truth`, `--aovs` and `--denoise` all arrived exactly that way.

---

## 7. Ground truth

A pipeline that reports fourteen corners is not telling you whether any of them
are real. The renderer knows, because it has the meshes and the camera.

```bash
npm run generate -- --out generated/ --scene cube --truth
npm run lab -- --script pipelines/geometry.lab --as linear \
               --truth generated/ --out results/ generated/*.png
npm run score   -- results/
npm run overlay -- generated/p0-l0.png results/ overlays/
```

`--truth` writes one `<name>.gt.json` per image: every **silhouette**, **crease**
and mesh **boundary** edge projected into image space, each with the fraction of
it that is really visible taken from the depth pass, plus the vertices they meet
at.

### What it cannot settle

Three limits, and they are not fine print. Every number below has to be read
with all three in view.

- **A geometric edge need not be a visible one.** Two walls meeting under flat
  lighting produce no gradient at all. Failing to detect it is not a failure.
- **A visible edge need not be geometric.** Shadow boundaries, specular
  terminators and texture are real image edges and none of them are in the
  ground truth. On the cube, the strongest unmatched detection in several views
  is the shadow the cube casts.
- **The ground truth resolves what the image cannot.** A 5 cm table top is two
  edges in the model and one line in the picture.

So a match rate says *how much of what the pipeline found is explained by
geometry*, not *how often the pipeline is right*. Recall in particular is a
floor, not an estimate.

### `npm run score`

```
OVERALL
  what          detected   real   invented   missed   precision   recall
  segments           372    252        120      204         68%      55%
  corners            661    162        499       36         25%      82%
```

25% precision at 82% recall is `corners` **working as designed**. It produces
hypotheses and leaves the deciding to a later stage, so it finds nearly every
real corner and invents three for each one. The question is whether the evidence
each candidate carries can sort them — which the last table in the report
answers, over as many views as you rendered:

```
endpointGap <= 7 px AND sigma <= 0.2 px      F1 0.89   precision 94%   recall 84%
endpointGap alone                            F1 0.80   precision 71%   recall 92%
sigma alone                                  F1 0.76
reach alone                                  F1 0.70
support alone                                F1 0.40
```

Measured over 24 views of a cube. **Threshold on `endpointGap` and `sigma`
together**; they ask genuinely different questions — whether the two edges
stopped near each other, and whether either fit was determined well enough to be
extrapolated at all. `support` carries nothing. `reach` is the weakest of the
three continuous fields.

Every threshold there is tuned to a cube in a lit room. A photograph will not
behave like this.

### `npm run overlay`

```bash
npm run overlay -- generated/p0-l0.png results/ overlays/
```

Draws ground truth and detections over the image: white/grey for visible/hidden
ground-truth edges, green/red for matched/unmatched detections, blue rings for
ground-truth corners, yellow/red dots for detected ones.

**This is not a convenience.** A scoring table reports a number whether or not
that number is right, and both defects ever found in this machinery were
invisible in the tally and obvious in one overlay image. Pass `--min-angle` to
match whatever you gave `match`, or the picture will disagree with the table for
reasons that are nobody's fault.

---

## 8. Reading the output

### `<name>.session.json`

```json
{
  "format": "cv-lab-2/session",
  "formatVersion": 1,
  "environment": { "app": "0.1.0", "electron": "43.4.0", "platform": "darwin/arm64" },
  "entries": [ … ]
}
```

Each entry:

```json
{
  "n": 3,
  "text": "gaussian(A#1, sigma=1.4)",
  "target": "B",
  "record": { "op": "gaussian", "version": 1,
              "inputs": [{ "slot": "A", "version": 1 }],
              "params": { "sigma": 1.4 }, "incidental": { "preview": false } },
  "output": { "kind": "buffer", "width": 512, "height": 512, "channels": 1,
              "dtype": "f32", "space": "linear", "hash": "sha256…" }
}
```

`incidental` holds the non-semantic parameters — `preview` and its like. They
are kept out of `text` and out of the hash, so toggling one never invalidates a
result or perturbs a comparison. They are still recorded, because "what was this
actually run with" is a fair question.

A `scalars` output carries `values` instead of dimensions; a `features` output
carries `count`.

**The hash is what makes reproducibility checkable rather than aspirational.**
Replay a session, compare hashes: a kernel change that altered results announces
itself. A stored script plus expected hashes is a regression test for free.

The environment is recorded once per session because compiler version and
optimisation level change floating-point results. A replay under a different
build is new provenance, not a contradiction. **Not yet recorded: the addon
build identity** — so a hash that moved because the compiler changed is
currently indistinguishable from one that moved because a kernel did.

### `<name>.features.json`

One entry per slot holding features:

```json
[ { "slot": "F", "width": 256, "height": 256, "features": [ … ] } ]
```

A feature list carries the **dimensions of the image it was measured in**,
because it has none of its own. That is what lets a viewer draw it over the
right tile.

**Every record carries a namespaced `type`.** The prefix is deliberate: a future
region or flow feature must not collide with an edge one merely by both wanting
the word "corner". Omitting it caused two silent defects — a feature hash that
collapsed different corner sets onto the same value, and an overlay that drew
corners as lines and produced `NaN` coordinates the canvas discards without
complaint.

| type | from | fields |
|---|---|---|
| `edge-segment` | `fit` | `id`, `pixels`, `x0 y0 x1 y1`, `length`, `angle`, `residual`, `rms`, `cx cy` |
| `edge-corner` | `corners` | `id`, `x y`, `support`, `segments`, `sigma`, `reach`, `endpointGap`, `angle` |
| `gt-edge` | `groundTruth` | `id`, `cause`, `objects`, `x0 y0 x1 y1`, `z0 z1`, `length`, `angle`, `dihedral`, `visible`, `clipped`, `v0 v1` |
| `gt-vertex` | `groundTruth` | `id`, `x y z`, `degree`, `visibleDegree`, `onFrame`, `visible`, `angle`, `objects` |
| `edge-match` | `match` | `id`, `kind`, `role`, `detected`, `truth`, `cause`, `objects`, `distance`, `angleDiff`, `x y` |

`role` is `hit`, `false-positive` or `miss`. Join a match record back to the
feature it judged by `detected` — that is how the evidence and the verdict come
together.

---

## 9. Colour space: the thing that will bite you

A value stored in an image file is **not proportional to light**. It is
gamma-encoded, so that 8 bits spread to match human perception. Two pixel arrays
with identical numbers can mean different things, and no amount of inspection
tells them apart. So every buffer carries a `space` field — `srgb`, `linear` or
`none` — and operations declare what they need.

| | needs `linear` | does not care |
|---|---|---|
| | blur, resize, any convolution whose positive weights sum to 1, means, alpha blending | threshold, median and rank filters, connected components, morphology — anything depending only on *ordering* |

Gradients are **different, not wrong**. Sobel on sRGB emphasises edges in dark
regions more than the same operator on linear values. Much of classical computer
vision runs happily on gamma-encoded images. The result is a different
measurement, which is exactly why the lab records which one you made.

**The lab refuses; it does not convert.** Auto-conversion would insert
processing that never appears in the log:

```
gray needs linear input, but S#1 is srgb. Convert it explicitly: X = toLinear(S)
```

`space: none` — masks, gradients, label maps — satisfies any requirement,
because a gradient is not a colour and the question does not apply.

**In practice:** if your pipeline blurs or greys, load with `as=linear`. The
supplied `pipelines/geometry.lab` says so at the top and `npm run lab` needs
`--as linear` to run it.

**The trap worth naming:** an untagged PNG holding *linear* samples — a
renderer's depth or position pass — decodes wrongly under the sRGB convention,
silently and nonlinearly. Nothing can detect it. The only defence is stating
`from=linear`.

---

## 10. When it goes wrong

### A pipeline runs green and produces nothing

The most common failure, and the reason `test/readme.js` exists — this document's
own predecessor shipped it. Every stage succeeds; `S` and `R` are all-zero label
maps and `F` and `C` are empty.

Two causes, both of which read perfectly well:

1. **`nms` was handed a signed derivative.** `nms(E, Gx, Gy)` where `E` is
   `sobel(axis=x)`. It drops everything ≤ 0, which is half of every edge. Pass
   `sobel(axis=mag)`.
2. **`minPixels` against small features.** The default is 8, and `pattern`'s
   checkerboard draws 8-pixel blocks, of which nothing survives a blur and
   thinning. Lower it, or use a bigger fixture.

Two hashes worth recognising in a log. **`4f53cda1…` is the hash of `[]`** — an
empty feature list, whatever produced it, at any size. **`30e14955…` is
1,048,576 zero bytes**, which is a 512×512 i32 label map with nothing in it; the
all-zero hash is size-dependent, so that particular value only means "blank" at
that particular shape. If you suspect a blank buffer at another size, hash
`Buffer.alloc(w * h * channels * 4)` and compare.

### Choosing parameters

Run `stats` on the intermediate, not on the input. Specifically:

- **`minMag`** — `stats` on your `nms` output. A synthetic step gives magnitudes
  near 0.5; a shaded render peaks around 0.06. The default 0.005 is set for the
  latter.
- **`low`/`high` for hysteresis** — `stats` on the magnitude, then start at
  roughly a 1:2 or 1:3 ratio.
- **`minPixels`** — how long is the shortest edge you care about, in pixels, at
  the resolution you are running?
- **`sigma`** — 1.4 unless you have a reason. Larger suppresses noise and
  rounds corners further, which pushes `endpointGap` up.

### Cost

**Quadratic in segment count, not resolution.** A megapixel of pixel work — blur,
gradients, thinning — is about 35 ms. Everything expensive is quadratic in the
number of *segments*, which is a property of the scene.

On a checkerboard at `minPixels=3`, which is close to a worst case:

| image | segments → merged | pixel stages | `segments` | `merge` | `fit` | `corners` |
|---|---|---|---|---|---|---|
| 256² | 2,015 → 1,518 | 2 ms | 1 ms | 33 ms | 2 ms | 0.3 s |
| 512² | 8,127 → 6,110 | 9 ms | 6 ms | 526 ms | 10 ms | 5.5 s |
| 1024² | 32,639 → 24,510 | 35 ms | 26 ms | 8.5 s | 39 ms | **125 s** |

**`corners` is the wall.** Nothing above a few thousand segments is interactive.
A batch run should watch the segment count, not the resolution. A cube in a room
gives about 15; the helmet in a room about 156; the numbers above are pathological
on purpose.

### Error messages you will meet

| message | what to do |
|---|---|
| `unknown operation "sobol" — known: …` | typo; the list is the whole registry |
| `gaussian has no parameter "sigmah" — did you mean sigma?` | typo in a parameter name |
| `unknown slot "Q" — defined: A, G, S` | the slot was never assigned, or the session was reset |
| `gray needs linear input, but S#1 is srgb…` | insert `toLinear`, or load with `as=linear` |
| `gaussian parameter "sigma": must be <= 100` | out of range; the registry carries the bounds |
| `parameter out of range (low must not exceed high)` | `hysteresis` arguments the wrong way round |
| `corners input 1 needs features, but A#1 holds buffer` | you passed a buffer where `fit` output belongs |
| `fitSegments: expects an i32 label map` | `fit` needs `segments`/`merge` output, not a magnitude |
| `load produces a buffer, so it needs a target: X = load(...)` | assign it to a slot |
| `channels must be between 1 and 4` | usually a 3-channel buffer where a single channel is wanted — insert `gray` |
| `match: the two feature lists were measured in different images` | ground truth and pipeline ran at different sizes |
| `line 1:28: unexpected trailing input` | the parser found something after the closing paren |

Every message names the line, and where it can, the column and the fix.

---

## 11. What it does not do

Stated plainly, so you do not go looking:

- **No loops, branches, arithmetic or variables** in the command language, and
  none are planned. Drive it from outside instead.
- **No undo/redo**, no node-graph editor, no automatic downstream recomputation.
  The log is append-only and nothing recomputes when an ancestor changes.
- **No plugins**, no layer compositing, no ROI editing.
- **8 bits per channel on input.** `load` borrows Chromium's decoder. 16-bit
  PNG, TIFF and camera raw need a native decode path that does not exist yet.
- **Alpha is dropped on load.** There is no compositing model.
- **An ICC-profiled PNG loads silently under the sRGB convention.** The profile
  is detected and then discarded; only explicit `sRGB` and `gAMA` declarations
  cause a refusal. Same for a `gAMA` value that is neither sRGB nor linear.
- **The AOV passes are exported and nothing consumes them.** Classifying an
  unmatched detection as texture, shading or noise needs a per-pixel operation
  that does not exist yet.
- **Bit-exactness holds within a machine and across the three supported
  platforms**, for the geometry and for every buffer this pipeline currently
  produces. It does **not** hold across compiler versions or optimisation
  levels — treat those as new provenance. `gaussian` still calls `exp`,
  `toLinear`/`toSrgb` call `pow`, and `orient` calls `atan2`; all three write
  `f32` and all three currently agree across the matrix, which is margin rather
  than proof.
