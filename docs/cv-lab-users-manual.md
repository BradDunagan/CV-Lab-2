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
B = gray(A)
C = gaussian(B, sigma=1.4)
D = sobel(C, axis=mag)
E = threshold(D, t=0.2)
stats(D)
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
you type   C = gaussian(B, sigma=1.4)
log holds  gaussian(B#1, sigma=1.4)   [v1]  →  C#1, sha256:31ab…
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

Twenty-three operations. Every one is a single entry in `src/lab/ops.js`, declared
against the schema in `src/lab/registry.js` — which is also what validates your
arguments and generates the error messages.

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

**It does not operate on the picture.** All three inputs are 1-channel `f32`
buffers derived from it, and all three must come from the *same* blurred image:
a **thinned magnitude**, and the two **signed** derivatives that say which way
each pixel's gradient points. The magnitude decides which pixels are edges at
all; `gx` and `gy` decide which of them belong to the same edge.

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

```lab
lin = load("samples/board.png", as=linear)
gry = gray(lin)
blr = gaussian(gry, sigma=1.4)

gx  = sobel(blr, axis=x)     // signed: negative on half of every edge
gy  = sobel(blr, axis=y)
mag = sobel(blr, axis=mag)   // a ridge, still several pixels wide

mag = nms(mag, gx, gy)       // thinned to one pixel -- THIS is what segments wants
lbl = segments(mag, gx, gy, minMag=0.005)
```

`mag = nms(mag, …)` does not overwrite anything: it appends a log entry and
binds the name to a new version, so the unthinned magnitude is still `mag#1` and
still reachable. `gx` and `gy` are passed on unthinned, and deliberately — they
carry direction, not strength.

`minMag` defaults to 0.005 rather than something rounder because it was tuned
against a real render: a hard 0→1 step gives gradient magnitudes near 0.5, and
a *shaded cube* peaks at **0.0585** after thinning — an order of magnitude
weaker. Run `stats` on your `nms` output before assuming any value.

#### `merge(src[1], gap, maxResidual, angleTol)` → i32 label map

Join segments that are collinear and nearly touching. `gap` 6 px,
`maxResidual` 1.0 px, `angleTol` 15°.

A separate operation rather than a flag on `segments`, so you can see what it
joined by comparing the two label maps.

#### `chain(src[1], gap, maxResidual, minTurn, maxTurn, minSagitta)` → i32 label map

Join segments that lie on one **circle**. Where `merge` asks whether two pieces
are the same line, this asks whether they are the same curve.

| parameter | default | what it does |
|---|---|---|
| `gap` | 4.0 px | how far apart the nearest endpoints may be |
| `maxResidual` | 1.0 px | how far any pixel of either piece may sit off the joined circle |
| `minTurn` | 2° | below this the two pieces are collinear, which is `merge`'s question |
| `maxTurn` | 40° | above this they meet at a corner |
| `minSagitta` | 1.0 px | how far the joined curve must bow off its own chord |

**Why it is needed at all.** `segments` grows a region under a *straight-line*
residual, so it cannot produce a long curved piece. An arc of chord `L` on
radius `r` departs from its own fitted line by `L²/(12r)`, and the gradient
direction turns with the arc, so `maxResidual` and `angleTol` each cap how far
a region can grow along a curve:

| | the cap |
|---|---|
| straightness | `L ≤ √(12·r·maxResidual)` |
| direction | `arc length ≤ r·angleTol` |

Measured on the nut, pieces land at **0.86 of the smaller cap** (range
0.72–1.08, over radii from 31 to 157 px), and `angleTol` is the binding one in
9 of 12 cases — not `maxResidual`, which is the intuitive guess and wrong below
about r = 90 at the defaults. The consequence is that after `merge`, 72 of 74
labels on a subject that is mostly curves were still too short to prefer a
circle to a line. Nothing was missing from the image; the curves arrive in
pieces, and this is what puts them back together.

**Both ends of the turn window matter.** Without the floor, one enormous circle
holds any two straight runs within a pixel and every straight edge in the image
chains into a single flat arc. Without the ceiling, a hexagon's 60° vertices
chain and a fitted curve walks around the whole subject.

Like `merge`, it is separate so you can see what it did: compare the two label
maps.

#### `fit(src[1] i32)` → features (`edge-segment`)

The point in the pipeline where pixels stop. Everything up to `merge` answers
*which* pixels belong to which edge; `fit` answers what each edge **is**, and
that answer has no pixels, no dimensions and no colour space of its own.
(`groundTruth` also produces features and `stats` produces scalars, but neither
is a stage: one reads a file, the other binds to no slot.)

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

#### `fitArcs(src[1] i32, minGain, minSweep, minSagitta)` → features (`edge-arc`)

The same label map described as circular arcs instead of lines — for the labels
that earn it.

| parameter | default | what it does |
|---|---|---|
| `minGain` | 1.5 | the circle's RMS must beat the line's by this factor |
| `minSweep` | 8° | shorter arcs are not enough of a curve to see |
| `minSagitta` | 1.0 px | and must bow at least this far off their own chord |

Per arc: `id`, `pixels`, the circle `cx cy r`, endpoints `x0 y0` and `x1 y1`,
`angle0` and `angle1`, `sweep`, `arcLength`, `chord`, `sagitta`, `residual`,
`rms`, `lineRms`, and the centroid `mx my`.

**A label that fails the gates produces no record.** It is not an error: it is a
line, and `fit` on the same map already says so. The two operations are two
descriptions of one label map, and running both is the comparison.

**Why there are gates at all, rather than a residual test.** A circle has a
parameter a line does not, and on a real edge it spends it on noise: three of
the twelve largest **straight** labels on the nut fit their own circle 7–21%
better than their own line. Nothing about one of those fits looks wrong on its
own — a slightly better residual, a radius in the hundreds — so comparing
residuals alone reclassifies a third of the straight edges in an image and
reports it as an improvement.

`angle0` and `angle1` use the same convention `fit`'s `angle` does — from
horizontal, in image coordinates where y increases **downward** — but over
[0, 360) rather than [0, 180), because an arc does have a direction. The arc
runs from `angle0` in the direction of increasing angle by `sweep`, so
`angle0 + sweep ≡ angle1`.

**Endpoints are projected onto the fitted circle**, radially, for the same
reason `fit` projects onto the line: the circle is an average over every pixel
in the label, so it localises the end better than that pixel's centre can.

**`sagitta` is how far the arc bows off its own chord**, in pixels, and it is
the scale-free way to ask whether something is curved. A radius means something
different on every image; "this does not depart from its chord by a pixel over
its whole length" does not.

Past half a circle it is measured to the *major* arc, so it keeps growing with
the sweep and reaches `2r` for a closed one. Taking the minor answer everywhere
is the obvious reading and it is wrong: a chord shrinks again past 180°, so a
disc's outline — which `chain` joins into one nearly closed label — would
report a bow of 0.01 px and be dismissed as a straight line.

Arcs **are** scored — `match` takes a list of them and compares it against the
same `gt-edge` truth segments are compared against. Read the caveat under
`match` on what the recall column means for one.

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

#### `fitPairs(src features, image[1] linear, …)` → features (`edge-pair`)

Place two close, near-parallel segments again, jointly, against the image
**before** the blur.

```lab
G = gray(A)
B = gaussian(G, sigma=1.4)
…
F = fit(R)
P = fitPairs(F, G)
```

Every segment was found in a blurred image, and two edges a few pixels apart
displace each other there: a true gap of 2.3 px reads 3.5. `fitPairs` takes
each pair of segments closer than `maxGap` and fits three plateaus and two
straight steps to the unblurred pixels around them. On the gap sweep that takes
the 2.3 px gap from +1.2 px of error to about −0.1.

| parameter | default | what it does |
|---|---|---|
| `maxGap` | 6 px | segments further apart than this are left alone |
| `maxAngle` | 5° | and so are ones further from parallel |
| `minOverlap` | 10 px | how much length they must share |
| `pad` | 4 px | plateau taken beyond each edge |
| `inset` | 2 px | left off each end of the shared stretch |
| `strip`, `stripLevel` | `fit`, 0 | `held` fixes the strip's level at `stripLevel` |
| `aperture`, `apertureWidth` | `fit`, 1 | `held` fixes the aperture at `apertureWidth` |
| `profile` | `box` | the shape of one step through the aperture: `box`, the pixel's square; `smooth`, a unit square blurred by a Gaussian-like kernel of the same total spread, as a lens blurs. The record says `profile` when it is not the box |
| `minSigmas` | 3 | a gap under this many `gapSigma` produces no record |
| `levelSlope` | `fit` | each level may brighten or darken along the pair; `none` holds them flat |
| `ledge` | `detect` | also ask whether a shadow ramp lies inside the strip; `none` does not ask |

Per pair: `id`; the two edges `a` and `b`, each with the `segment` it came
from, its line `x0 y0 x1 y1` over the stretch they share, and `shift`, how far
it moved from its detection; the frame's origin `x y` and normal `nx ny`;
`gap` and `gapSigma`; `detectedGap`; the three `levels` (beyond `a`, the
strip, beyond `b`), at the middle of the stretch, and `levelSlopes`, how
much each changes per px along it (null with `levelSlope=none`); `strip`;
`aperture`, `apertureFrom` and `apertureSegments`; `rms`, `samples`,
`iterations`, `converged`.

**`ledge` is a detector.** Where one part sits back from the other, a ledge of
the further part's face shows inside the gap, and an area light's soft shadow
lies across it: the brightness ramps down over a pixel or two from that edge
instead of stepping. Two sharp edges and a flat strip misplace that edge by up
to half a pixel. Gaps of 2 px and more are fitted again with a ramp starting
at each edge in turn; `ledge.gain` is how much better the best of them fits
(1.4 to 2.5 over a ledge on the stack, 1.0 to 1.1 without one) and
`ledge.edge` which edge (`a` or `b`) it starts at. It does not move the
edges: the pixels cannot place an edge under a penumbra to better than about
0.2 px. `gap-sweep --carry` uses it to choose the frame it takes the still
edge from (`design-lab-model.md` §5, "A sixteenth").

**A face is rarely lit evenly, and the levels slope for that.** Held flat, a
face brighter at one end of the pair than the other turns the two edges
opposite ways: on the stack's renders, 0.3 px of gap from one end of a pair to
the other while the middle read true. `levelSlope=none` is there to compare
against.

**`image` must be the gray image before `gaussian`, and linear.** Nothing can
check the first: a blurred buffer has the same shape, and fitting it returns
the blurred answer with a small residual.

**The aperture is how far a pixel gathers its light from**, as the side of a
square in pixels. It decides how soft every step looks, so a narrow gap
cannot be read without it. `fit` measures it on the image's *lone* segments,
those in no pair, takes the median, and holds it for every pair;
`apertureFrom` says `segments` and `apertureSegments` how many. With no lone segment long enough (20 px) and
off the pixel axes, it falls back to `apertureWidth` and says `default`. An
axis-aligned edge says nothing about the aperture, so a synthetic image of
horizontal and vertical edges always falls back.

**`gapSigma` says how well the pixels pin the gap.** It grows as the strip
narrows, and under about a pixel and a half the strip's width and its level
trade off: a narrow dark strip and a wider, less dark one are nearly the same
pixels. If you know the level, from a frame where the gap was wider, hold it
with `strip=held, stripLevel=…`: a 1.16 px gap read 0.86 to 0.92 with the
level fitted and 0.99 to 1.02 with it held. `gapSigma` is a scale for
comparing fits, not a confidence interval, and it understates.

**A pair is not always two parts.** Any two close parallel segments are
fitted: an edge and the shadow boundary beside it, or the two sides of a thin
line. Join on `a.segment` and `b.segment` to find the pair you mean.

**No record** means the two are not a pair (too far apart, not parallel, not
overlapping), or the model could not describe them, or the gap could not be
told from none. The last is one edge detected twice, or two parts in contact;
this cannot say which.

#### `findPairs(src features, image[1] linear, …)` → features (`edge-pair`)

Find the pairs the detector reported as **one** segment: a strip hidden
inside it.

```lab
P = fitPairs(F, G)
H = findPairs(F, G)
```

Closer than about a pixel and a half, the blur that finds edges merges two of
them into one, and `fitPairs` has nothing to place. `findPairs` walks every
segment that is in no pair, a `window` at a time, and asks the unblurred
pixels whether that stretch is one step or two. Runs of windows that say two
are joined and fitted once more as a whole. On the gap sweep it finds the Cube
1 mm (1.16 px) over the Table inside the 512 px segment along the table's
edge.

| parameter | default | what it does |
|---|---|---|
| `window` | 24 px | how much of a segment is tested at a time |
| `reach` | 2.4 px | how far to one side the second edge may be |
| `minGain` | 1.3 | two steps must fit better than one by this factor in rms |
| `minSigmas` | 3 | a gap under this many `gapSigma` is not reported |
| `pad`, `inset` | 4, 2 px | as for `fitPairs` |
| `strip`, `stripLevel` | `fit`, 0 | as for `fitPairs` |
| `aperture`, `apertureWidth` | `fit`, 1 | as for `fitPairs`, measured on the *other* lone segments |
| `profile` | `box` | as for `fitPairs` |
| `maxGap`, `maxAngle`, `minOverlap` | 6, 5°, 10 | which segments are already a pair and so not searched; leave them at `fitPairs`'s |

The records are `edge-pair`, as `fitPairs` writes them, with **both edges
naming the same segment** and a `gain` beside them. `shift` is each edge's
distance from the detected line, so one is small (the edge the detector
found) and the other is about the gap. `detectedGap` is 0.

**Three things stop a record**, each for a reason:

- **`minGain`.** Two steps have more parameters than one and always fit a
  little better. Along an edge hiding nothing the gain is 1.00 to 1.05; over a
  1.16 px strip it was 1.35 to 2.57. The default was set on two renders of one
  scene.
- **The strip must be darker than both its neighbours, or brighter than
  both.** A level between them is what a single soft edge looks like, and soft
  edges are common. So a real strip between its neighbours' levels is **not
  found**, unless you hold its level, which says what it is.
- **`reach`.** A second edge further off than this is one the detector should
  have found.

**A segment nearly along the pixel grid is not searched.** Where a window
climbs less than one pixel from end to end (under about 2.4° at the default
window), every pixel crosses the edge at the same place and a sub-pixel strip
cannot be read. A synthetic image of horizontal and vertical edges finds
nothing.

**Trust that it found something more than how wide it says it is.** At
1.16 px the gap read 0.88 to 0.92 with the level fitted and 1.00 to 1.02 with
it held. At 0.58 px it finds nothing at the defaults, and once misread one as
1.02 px.

**With `strip=held` and `minGain=1`** it reads a 0.58 px gap as 0.33 to 0.36
and reports nothing at contact, but it also reports 5 to 19 records an image
along edges that hide nothing. Only use that if you already know which
segment you are asking about.

It costs about a second an image at 512 px, far more than everything before
it together.

#### `trackPair(image[1] linear, …)` → features (`edge-track`)

```
K1 = trackPair(G, x0=173.06, y0=262.04, x1=268.29, y1=288.18, towardX=222.2, towardY=269.3, stripLevel=0.069, aperture=1.42, guess=5.97)
```

Read a pair again beside a line carried in from an **earlier frame**. Under
about a pixel neither `fitPairs` nor `findPairs` can read a gap reliably: the
strip's width and level trade, and the detector reports one segment or none.
But in an approach only one part moves. The other part's edge is the same
line in every frame, and the strip's level and the aperture were measured
while the gap was wide. Given all three, held, only the moving part's edge is
fitted, and nothing has to have been detected.

| param | default | |
|---|---|---|
| `x0`, `y0`, `x1`, `y1` | 0 | the still part's edge, as an earlier frame's `fitPairs` record placed it, over the stretch the pair shared |
| `towardX`, `towardY` | 0 | any point on the moving part's side of that line |
| `stripLevel` | 0 | the strip's level from that record |
| `aperture` | 1 | the aperture from that record |
| `profile` | `box` | the profile from that record |
| `guess` | 1 px | where the fit starts; it also starts at 0.25, 0.5, 1 and 2 and keeps the best |
| `pad` | 4 px | plateau taken beyond each edge |
| `levelSlope` | `fit` | as for `fitPairs` |
| `strip` | `held` | `held`: the strip level carried in, for a strip too narrow to show its own. `fit`: only the line is carried |
| `ledge` | `none` | a lit ledge inside the strip, up to the moving part's shadow. `held`: the shadow's middle `ledgeOffset` px from the moving edge toward the still one, `ledgeWidth` px wide; `fit`: placed freely, to measure it |
| `ledgeOffset`, `ledgeWidth` | 0 | for `ledge=held`; `gap-sweep --ledge` writes them in |
| `ledgeShift` | 1 px | a held ledge is refused if it moves the moving edge more than this from the strip alone's reading |

The carried values are **parameters**, numbers in the command, so they are
in this frame's log and the frame replays on its own. Nothing in the
language computes them; `gap-sweep --carry` writes them in.

**Strip, or one edge.** The same pixels are also fitted as a single edge
beside the line, and as two edges with neither held. Where the parts' faces
meet with no strip between them (in contact, or with the moving edge past
the still one, an overhang) the picture is one edge, and its signed distance
from the line is the gap: about zero, or negative. The record is a strip
(`model: 'strip'`) when two held edges fit 1.2 times better than one (`ratio`)
or two free edges fit 1.15 times better (`freeRatio`); a single edge
(`model: 'edge'`) when two held edges fit no better than one and the free fit
finds no strip either. Between, both happen, and no record is made: a real
0.3 px gap and a 0.4 px overhang look alike. On the stack's test poses the
single edge read overhangs of −0.43, −0.82 and −1.19 px as −0.52, −0.87 and
−1.27.

One record, or none: `still` (the line as given), `toward`, `moving` (the
fitted edge over the same stretch), `gap` at the line's middle (positive
toward `toward`, negative for an overhang), `gapSigma`, `model`, `ratio`,
`freeRatio`, `levels`, `levelSlopes`, `strip` and `stripLevel` (null for one
edge), `aperture`, `rms`, `samples`, `iterations`, `converged`, and `ledge`
with `ledge=held` or `fit` (below).

- **An error in the carried line**: over a pixel it is an error in the gap,
  one for one. Under one, the strip's darkness sets the width and the moving
  edge follows the line instead: 0.2 px off cost a 0.6 px gap 0.02. Either
  way `rms` rises, about a hundredfold for 0.2 px.
- **Contact is not refused in every view.** Most return nothing; a few return
  0.02 to 0.10 px with a `gapSigma` small enough to pass a 3-sigma test.
  Whether the parts can be touching is the caller's to decide.

**A ledge.** When the part above has slid back, the strip is not one level.
Next to the still edge is a strip of the still part's top face, lit, and
then the moving part's shadow across it; the dark gap is only beyond that.
Read as one flat strip it puts the moving edge too far out, by more the
further the part slid. With `ledge=held` the strip is three levels, still
edge, lit ledge, a soft shadow edge and the dark, and the shadow's position
is tied to the moving edge, so one more level is fitted and nothing else. A
shadow placed behind the still edge (no ledge in sight) leaves the plain
model exactly. The record gains `ledge`: the `offset`, `width`, the lit
`level`, `lit` (the shadow's distance from the still edge; `seen` when
positive) and `gain` (the plain fit's rms over this one's). A held ledge
that moves the moving edge more than `ledgeShift` px from the plain fit's is
refused and the plain record returned: a real one moved it under 0.6 px on
every stack run, and a sharp shadow can pass for the moving edge ("A
thirty-third"). `ledge=fit`
places the shadow freely as well. That is for measuring a scene's shadow on
sharp images (`npm run ledge`), not for reading gaps: freed per frame it
wanders where there is no ledge, and through a lens's blur it overstates
the shadow's width (`design-lab-model.md` §5, "A thirty-second").

#### `match(src features, truth features, …)` → features (`edge-match`)

Score detected features against ground truth. Dispatches on what the *detected*
records say they are: `edge-segment` and `edge-arc` go to the ground truth's
edges, `edge-corner` to its vertices. One kind at a time — a mixed list is
refused, because the two that go to edges and the one that goes to vertices are
different questions.

| parameter | default | what it does |
|---|---|---|
| `maxDistance` | 3 px | how close counts as the same thing |
| `maxAngle` | 20° | how differently a matched segment may run |
| `minVisible` | 0.5 | which ground-truth edges the detector is answerable for |
| `minAngle` | 30° | which ground-truth vertices count as corners rather than polyline bends |

**Two passes, asking two different questions.** Precision walks the detections:
is this one explained by geometry? Recall walks the ground truth: was this edge
found by anything? They are not each other's inverse, and treating them as one
was a real defect — crediting only the single nearest truth edge per detection
made a segment lying along twelve facets of a ball's silhouette mark one found
and eleven missed, and recall read 40% for a line drawn straight down the
middle of all of them.

That structure is also what makes arcs cost almost nothing to score. A fitted
arc crosses a fan of mesh chords, and each chord is asked separately whether
anything covers it.

**An arc is measured as a curve, never as its chord.** Samples run along the
sweep, distance is to the arc and clamped to its own extent — a detection on
the far side of the same circle is not near it — and a truth edge's angle is
compared against the arc's **tangent** where that edge is, since an arc has no
single direction. In practice the angle gate seldom decides an arc on its own:
an edge at much of an angle to a curve is already far from most of it, so the
median distance gets there first.

**Recall is over the truth that list could have found.** `fit` and `fitArcs`
describe one label map, so an edge covered by a segment counts as missed by the
arcs. Score them in separate slots, read the two recalls separately, and never
add them.

Refuses two feature lists measured in different images, because scoring a
512-pixel run against 256-pixel truth produces plausible numbers rather than an
error.

#### `explain(src features, depth, normal, albedo, truth features, …)` → features

Say what put each detected feature in the picture, from the renderer's
auxiliary passes. Returns the same records with a `cause` and the measurements
behind it.

| `cause` | measured | means |
|---|---|---|
| `occlusion` | a depth step the surface cannot explain | one surface ending in front of another |
| `crease` | a normal step, no depth step | a fold |
| `texture` | an albedo step, neither of the above | paint rather than shape |
| `shading` | none of the three | a shadow boundary or specular terminator |

**The depth test is a residual, and v1 got that wrong.** Sampling a fixed
distance either side of an edge on a surface *turned away* from the camera
reads a large depth difference with nothing occluding anything — the surface
simply recedes. v1 compared the raw difference against the threshold, and over
six helmet views **241 of the 282 detections it called `occlusion` were that**:
a single tangent plane accounted for the difference to within 1%, where across
a genuine step the same plane accounts for 7% of it. v2 extends each side's
tangent plane to the other side and asks whether the depth recorded there is
where a continuous surface would have put it. What is left over is the
evidence. Re-run on the same six views, invented `occlusion` falls 282 → 88 and
every one of the 199 detections sitting on a verified real step keeps it.

Four numbers are recorded per feature, so a record says which it was:

| field | is |
|---|---|
| `depthStep` | the depth difference actually measured across the edge |
| `planeStep` | how much of it a continuous surface at that orientation accounts for |
| `depthExcess` | what is left — the quantity the threshold is applied to |
| `slant` | how far the surface is turned from the line of sight, in degrees |

`slant` is reported and **not** thresholded, deliberately: median slant is
64.0° under the misread detections and 64.1° under the genuine steps, because
both live at a silhouette — where a surface turns away *and* where one surface
ends in front of another. Only the residual separates them.

**`shading` is not a detector failure.** A shadow boundary is a real image edge
belonging to the *light* rather than to the object, so the detector is right to
find it and ground truth — which models geometry alone — is right to call it
invented. Before this operation the two were scored together as "not geometry",
which pooled a detector that was wrong with a detector that was answering a
question nobody asked.

| parameter | default | what it does |
|---|---|---|
| `offset` | 2.5 px | how far either side of the edge to sample |
| `samples` | 7 | crossings along a segment; a corner is always crossed on four axes |
| `depthStep` | 0.02 | metres of *unexplained* depth change that counts as a step |
| `normalStep` | 20° | angle between the two sides' normals that counts as a fold |
| `albedoStep` | 0.06 | linear reflectance difference that counts as paint |

The order of the tests is not arbitrary. An occluding edge has a normal step
too — the two surfaces face different ways — and usually an albedo step as
well, so depth is tested first; testing normal first would report every
silhouette as a crease.

Takes **detections**, not match records: sampling across an edge needs its
direction, and a match record keeps only a midpoint. It also means the answer
is available whether or not the detection matched anything, which is what makes
"what does this detector respond to?" a question you can ask.

A pass that is not supplied leaves the cause `unknown` rather than falling
through to `shading` — reaching that answer by not looking would be a confident
wrong one, and `shading` is exactly the bucket this exists to stop over-filling.

**It takes the ground truth for two numbers, not for scoring** — it never looks
at the truth's features. The metre scale the depth pass was packed against,
`maxDepth`, exists only in the `.gt.json`: the passes carry no colour chunks and
therefore no metadata at all. It also changes per image, so it could not be a
parameter written into a script. The second is the camera's **field of view**,
which is what turns a pixel offset into a direction and so into the tangent
plane above; without it a depth difference cannot be separated from a surface
turned away, and the operation refuses rather than quietly computing v1's
answer. Only the fov is needed, not where the camera is: the normal pass is in
**view space**, so its normals are already in the frame the depth pass is
measured in.

Read the passes with `from=linear`. They carry raw code values and pt-lab
writes them with no colour chunks at all, so the sRGB-by-convention default
applies a transfer curve that was never there. `npm run lab -- --aovs <dir>`
prepends the three loads correctly, per image.

---

## 4. The application

`npm start`.

### Panes

A tiling workspace. **Panes → New Slot Pane** (⌘N) adds a tile; **New Log Pane**
adds the session log; **Scene Editor…** (⌘E) opens pt-lab's scene editor, and
**Generate Images…** (⌘G) opens the generator frame.

A slot pane shows one slot. Click the slot name in its header to bind a
different one. Its header reads `A#2  512×512×1 f32 linear` — name, version,
dimensions, channels, dtype and colour space.

### View controls

Per tile, and **non-destructive** — they change how a buffer is drawn, never
what it contains. The next operation in the pipeline sees the real numbers.

| control | options |
|---|---|
| view | `image`, `histogram` |
| colormap | `gray`, `viridis`, `turbo`, `diverging`, `categorical`, `cyclic`, `mask` |
| range | `auto`, `percentile`, `symmetric` |
| curve | `linear`, `log`, `abs`, `sqrt` |
| channel | `all`, or one |

**The defaults are chosen by data kind, and they are what make a result
readable rather than a grey smear:**

| data | default |
|---|---|
| `i32` label map | **mask**, auto — every label the same light grey on black, never interpolated, because a label is a name and the average of region 3 and region 9 is not region 6. `categorical` gives each label its own colour when *which* one matters; the default answers the question a segment map is usually asked, which is *where*, and leaves the tile legible under the overlay drawn on top of it |
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

Four scripts ship in `pipelines/`:

| | |
|---|---|
| `geometry.lab` | the straight-edge pipeline, all the way to scored corners |
| `explained.lab` | the same, plus `explain` over the renderer's AOV passes |
| `curves.lab` | the curve branch — `chain` and `fitArcs` beside `fit`. Needs no ground truth, because arcs are not scored |
| `pairs.lab` | `explained.lab` plus `fitPairs` and `findPairs`: close pairs placed again against the unblurred image, and the ones detected as a single segment found. For `gap-sweep --script` |

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
| `--extra <json>` | more commands per image, run after the script: `{"<name>": ["K1 = trackPair(G, …)", …]}` |
| `--quiet` | only report failures |

Each image gets a **fresh session**, because slot names repeat and a leftover
binding would feed one image's buffer into the next image's pipeline. The
runner prepends the load — and, with `--truth`, the ground-truth load — then
runs your script:

```
A = load("<image>", from=<from>, as=<as>)
T = groundTruth("<truth-dir>/<name>.gt.json")
```

With `--extra`, an image named in the file then runs its own commands too.
They are ordinary commands and go into that image's log like any other. This
is how a number measured in one frame reaches another without the language
growing variables: whoever drives the frames writes it into the command.
`gap-sweep --carry` does exactly this with `trackPair`.

so write your script against `A` and `T`.

Exit codes mean something: **0** all passed, **1** a pipeline failed, **2** a
usage error.

It runs under Electron with no window, for one reason only: `load` borrows
Chromium's decoder. It drives the same `window.lab` bridge the interface does,
so the batch path cannot drift from what the app does.

---

## 6. Generating images

Varying the lighting and the pose and re-running your pipeline over the result
is the loop this lab is for, so **image generation ships as part of the
application**. In an installed CV-Lab it is **Panes → Generate Images…** (⌘G),
with no checkout, no build and nothing to install — the path tracer, the model
and the environment are all inside the app.

It needs a GPU capable of WebGL path tracing, which is the one real
requirement, and about 20 s per image. The frame is split: the controls on the
left, and the tracer itself on the right, converging while the sweep runs.

### Composing a scene: Panes → Scene Editor…

**Panes → Scene Editor…** (⌘E) opens pt-lab's scene editor in a frame split
like the Generate frame's: controls on the left, the scene on the right. The
right-hand pane is pt-lab's own view — a raster preview for editing, or a
path-traced preview of what Generate will render — from the same bundle as the
generator, so it needs the same build and says so when it is missing. Drag in
it to orbit the camera.

The controls are a column in three tabs, because there is more than fits one:

| tab | what it holds |
|---|---|
| **Scene** | which scene is open; New, Save, and Save As with a name and a *private* box; the path-traced preview, whether to denoise it, and how many samples it accumulates; the room, and its overhead lamp's power and colour; the camera and its target as numbers; and a status line — the file, whether there are unsaved changes, and what the last save or error said |
| **Objects** | the object library, ● in the scene and ○ only in the library; Import .glb…; the bundled objects; and, for the selected object, Include/Exclude, Remove (imported objects only), colour as `#rrggbb`, shininess, metalness, and position, rotation (degrees) and scale |
| **Lights** | the scene's lights; Add light and Remove; and, for the selected light, its name, type, colour, power (candela for point and spot, nits for area — changing type resets it to that type's default) and position |

**Denoise the preview** runs OIDN over the path-traced view — the same
denoiser Generate's *denoise* box applies to a render, and like it, off by
default. It is a viewing choice, not part of the scene: nothing about it is
saved, and it does not decide whether Generate denoises. It needs WebGPU,
loads its model the first time, and re-runs as samples accumulate; the status
line says where it is, including the sample count the last pass finished at.

**Samples** is where the path-traced preview stops: 16 unless changed, and
any whole number from 1 to 16384. Raising it carries on from where the
preview paused rather than starting again; lowering it below what is already
there stops at once. Like denoise it is a viewing choice — Generate has its
own sample count — and nothing about it is saved with the scene.

When the preview has every sample it will get — and, with denoise on, the
denoiser's final pass at that count has finished — the status line ends with a
blank line and **Render finished.** A denoise pass partway through does not
count: at 8 of 16 the image on screen is not the finished one. Without WebGPU
the denoiser never runs, so there the sample count alone decides it, and the
status line says the image is not denoised. The raster edit view never
finishes; there is nothing for it to converge to.

A number or a colour takes effect when you press Enter or leave the field; a
slider as you drag it. The column shows what pt-lab holds rather than what was
typed: every change goes to the scene and comes back, so a value pt-lab
refuses — a colour that is not `#rrggbb` — simply does not change.

What differs from pt-lab's own editor is where a scene goes. **Save writes
`scenes/<name>.json`**, the file the Generate pane offers and the CLI takes as
`--scene saved:<name>` — so there is no Export step and nothing to copy, and
Generate's scene list updates the moment a save lands.

- **Save** writes a scene back to the file it was opened from, whatever that
  file is called: `nut-1.pt-scene.local.json` stays that.
- **Save As** takes a new name — letters, digits, `-` and `_`, no dots, because
  the name is what is left after the suffixes are stripped. An existing name is
  refused rather than overwritten; open that scene to change it. Tick
  **private** for `<name>.local.json`, which is not committed.
- **Imported models** travel with the save. A `.glb` imported in the editor is
  written to `scenes/models/` under pt-lab's name-plus-hash file name —
  `.local.glb` for a private scene — and a model already there is hash-checked
  rather than rewritten. Every problem is found before anything is written, so
  a refused save leaves nothing behind.
- **Opening** a scene runs the same model checks a render does, so the editor
  refuses exactly the scenes the generator would.
- A scene in a file that holds several — the map form below — opens, but saves
  only under a new name: saving it back would rewrite the others.
- Closing the frame with unsaved changes asks first; **Keep Editing** reopens
  it with the editor as it was.

Left out on purpose: pt-lab's Save PNG, depth-pass and rotation-series
exports, and its demo scenes. Images come from Generate, as a sweep with
provenance. So is the field of view: a scene does not record one, so a FOV
set in the editor would look saved and not be.

The editor runs as its own origin (`gen://editor`), apart from the generator
(`gen://lab`). pt-lab keeps imported models in its origin's IndexedDB and loads
all of them into the library on every start, so sharing an origin would put
whatever was last imported in the editor into every render's library.

**In an installed app** scenes live in `~/Documents/CV-Lab/scenes/` (the
app bundle is read-only), beside the `~/Pictures/CV-Lab` its images go to. A
working copy uses the repository's `scenes/`.

### Which scenes the pane offers

Exactly the ones in `scenes/`, and nothing else. A scene there is a file —
one per scene, named for the scene — composed in the Scene Editor (or in
pt-lab's own editor and exported as JSON): its objects with their materials and
transforms, the room, any lights added in the editor, and a camera.
`scenes/cube-1.json` ships with the repository.

Files rather than browser storage is deliberate. pt-lab's own editor keeps its
scenes in `localStorage`, which is partitioned by ORIGIN — nothing else can read
it: not another browser, another machine, or CI. As
files they can be committed, hashed and replayed, which is what this project
promises of everything else. `scenes/*.local.json` is gitignored, for a scene a
working copy should have and a public repository should not. The suffix is not
part of the name — `scenes/lamp.local.json` is `saved:lamp` — so a private copy
kept beside a committed scene of the same name is refused, naming both files,
rather than one silently rendering as the other. Neither is `.pt-scene`, which
pt-lab's Export puts on every file: `nut-1.pt-scene.json` is `saved:nut-1`
copied in as it is, and `nut-1.pt-scene.local.json` keeps it private. The
suffixes are only stripped in that order, because it is the order `.gitignore`
honours — `nut-1.local.pt-scene.json` is committed, and is named
`nut-1.local` so that it does not look private.

**Imported models travel as files beside the scene.** pt-lab's editor stores
a model imported into it in that browser's IndexedDB and names it in the scene
by an `import-…` key, which nothing outside that browser can resolve — the hex
nut and screw bundled with pt-lab included, since its demo imports them the
same way. So pt-lab's **Export** writes, beside the scene's JSON, the `.glb` of
every imported model the scene includes, and records in the scene each one's
file name (`glb`) and the SHA-256 of its bytes (`sha256`):

```
scenes/nut-1.pt-scene.json
scenes/models/90593A005_Black-Oxide Medium-Strength Steel Hex Nut-32a69b25ed49.glb
```

Copy the JSON into `scenes/` and the models into `scenes/models/`. The file
name ends in the first 12 hex digits of the hash, so two different models that
share a name cannot overwrite each other there, and a model several scenes use
is one file. `<name>.local.glb` keeps a model out of the repository, as
`.local.json` does a scene.

Before anything renders — and under `--dry-run` — the generator finds each
included model and hashes it, and **refuses the scene**, naming every problem at
once, if a file is missing, its bytes are not the model the scene recorded,
both a shared and a `.local` copy exist, or the recorded name is not a plain
file name. A scene saved before Export wrote models has no `glb` for its imports
and is refused with that said: re-export it. The models are then handed to
pt-lab under the scene's own keys, in memory only — nothing is written to the
generator's browser storage, which pt-lab reloads on every start and which
would otherwise make one render depend on the last.

As a last line, the generator compares what the scene includes with what pt-lab
reports it built, and refuses any difference. pt-lab builds nothing for a key it
does not have and says nothing about it, so without this a scene would render
with its subject missing.

**A model is only as good a ground-truth subject as its mesh.** pt-lab's hex nut
has its threads modelled: one view at 256 px lists 6,672 truth edges, 2,548 of
them visible — the helmet's problem, not the cube's.

**The pane has no room or light controls.** A scene records the room and the
lights it was composed with, so a control here could only contradict the file.
The command line keeps `--room` and `--light` for the experiment they are good
for: one subject, several backgrounds or several lightings.

From a working copy there is a command line as well, which takes those same
files as `--scene saved:<name>`:

```bash
npm run build:generate                                    # once
npm run generate -- --out generated/ --scene saved:cube-1 --truth --aovs
```

It also has two built-in scenes the pane does not offer, `helmet` and `cube`.
They exist for their bespoke **shot plans**, which a saved scene cannot express
— the editor frames one camera, and a sweep is derived from it, whereas `cube`
places the camera 20° off the axis so no view lands on a degenerate one and 25°
above so three faces and seven vertices show. That is the case
`design-lab-model.md` §5's claim is about.

**pt-lab is in this repository, under `pt-lab/`, and only the build reads
it** — which is what lets the feature ship at all. It used to be a sibling
checkout; see [pt-lab/README.md](../pt-lab/README.md) for why it moved and
what it is. Only `generate` needs a GPU:

| | reads `pt-lab/` | GPU |
|---|---|---|
| `build:generate` | **yes** — `pt-lab/src/` for the code, `pt-lab/assets/` for the model, environment and denoiser weights; three, three-gpu-pathtracer, three-mesh-bvh and oidn-web come from this repository's devDependencies | no — it is a Vite build |
| `generate`, and the installed app | **no** — a built `dist-generate/` carries everything it needs | **yes** — path tracing is WebGL |

`npm run package` runs `build:generate` and puts `dist-generate/` inside the
`app.asar`, about 17 MB of the installer. It needs no `asarUnpack`, unlike the
native addon: `net.fetch` on a `file://` URL reads inside an archive, verified
rather than assumed — a 3.7 MB glTF comes back byte-identical.

That is what the copy step in `vite.generate.config.mjs` is for. pt-lab's
default URLs are `./assets/…`, resolved against `gen://lab/index.html`, and
nothing imports those files — so without the copy they would be fetched from
`pt-lab/assets/` at render time, which a packaged app does not have. (Before
the copy existed, that meant fetching them from the sibling checkout, and a
complete, correct build could fail on its first frame because the checkout had
moved.) They are fetched on **every** run, `--scene cube` included, because
`init()` loads the model and the environment before `applyScene` replaces them.

A bundle built before that copy existed still works: the handler falls back to
`pt-lab/assets/` when the bundle has no assets of its own. One function,
`assetsDir()`, decides for both the handler and the prerequisite check, so the
two cannot disagree about where a file is meant to come from.

`build:generate` is needed **once**, and again whenever pt-lab's source
changes — see below. `npm run dev:generate` is the same build in watch mode, if
you are editing pt-lab and cv-lab-2 together.

| option | default | |
|---|---|---|
| `--out <dir>` | — | required |
| `--scene <name>` | `helmet` | `helmet` \| `cube` \| `saved:<name>` |
| `--size <px>` | 512 | square |
| `--samples <n>` | 96 | path-tracing samples per image |
| `--positions <n>` | 3 | camera positions |
| `--lighting <n>` | 2 | light intensities |
| `--room <kind>` | the scene's own | `room` \| `room-emissive` \| `room-arealight` \| `none` |
| `--light <spec>` | the scene's own | add a light; repeatable; replaces the scene's lights — see below |
| `--no-lights` | off | render without the scene's own lights |
| `--aovs` | off | also write depth, normal and albedo passes |
| `--truth` | off | also write `<name>.gt.json` |
| `--crease-angle <d>` | 20° | how sharp a fold counts as an edge |
| `--denoise` | off | run OIDN over each export |
| `--tone-mapping <k>` | `aces` | `aces` or `linear`. Use `linear` for measurement; see below |
| `--exposure <x>` | 1 | multiplies radiance before tone mapping |
| `--show` | off | show pt-lab's window and watch it converge |
| `--shots <file>` | — | render this JSON list of shots instead of the scene's plan; each may place objects. See `npm run generate -- --help` |
| `--dry-run` | off | print the sweep, render nothing |

About **20 s per image**. `--dry-run` before committing several minutes.

The pane takes the same options. Where it writes them differs, and deliberately:
a relative path resolves against a working directory an installed app never
chose — `/` on macOS when launched from Finder — so the pane asks the main
process for somewhere real and offers **`~/Pictures/CV-Lab`**. The CLI keeps
relative-to-cwd, which is what a CLI should do.

**The two scenes are for different questions.** `helmet` is a dense textured
mesh — a fine detector workout and a poor thing to grade against geometry, but
not for the reason this said until it was measured. Its edges are **not**
overwhelmingly paint: over six views at 256 px, 61% of detected segments match
real geometry and only 8% of the invented ones are texture. What makes it a poor
subject is the truth set, which lists ~3,000 visible edges a view against ~160
detections. The 73% of invented segments that appeared to sit on a real depth
step were mostly the measurement: `explain` v1 read a surface receding from the
camera as a step, and correcting that drops them to 23%. `cube` is a 10 cm cube on a table with a ball
beside it: twelve edges and eight vertices in known places, nine and seven of
them visible from a general viewpoint.

**Ground-truth visibility is computed at the render size.** The same scene from
the same camera reports 3,045 visible edges at 256 px and 2,587 at 512 px —
18% more at the lower resolution, because a coarser depth buffer occludes less
of a dense mesh. The total never changes; only the visible fraction does. So a
**recall number is only comparable within one render size**, and nothing in the
scoring output says so.

### The room lamp

Every room has an overhead lamp: the ceiling fixture — a sampled area light in
`room-arealight`, an emissive panel in `room-emissive`, a bright patch painted
into the environment in `room`. Its **power** (radiance in nits, 40 by default)
and **colour** (`#fffdf8`, faintly warm) are part of the scene: the Scene
Editor's *lamp* and *lamp rgb* controls set them, Save writes them to the file
as `lamp`, and Generate renders them. A scene saved before the lamp could be
changed has no `lamp` and gets exactly the 40-nit `#fffdf8` lamp every earlier
render had — checked by rendering `cube-1` before and after, which differ by
no more than two renders of the same build do.

`--lighting` multiplies the lamp as it multiplies everything else, so a scene
with an 80-nit lamp renders at 40, 80 and 160 across `--lighting 3`. The ready
line prints the lamp pt-lab applied, before the multiplier:

```
  room lamp  40 nt #fffdf8
```

### Lights

pt-lab's editor can add point, spot and area lights to a scene, **on top of**
the room's own lamp or environment — never instead of it. A scene saved with
lights brings them along, in the pane and on the command line alike. From the
command line, a light is `<type>[:<intensity>][@<x>,<y>,<z>][#<rrggbb>]`:

```bash
npm run generate -- --out generated/spot --scene saved:cube-1 \
  --light 'spot:60@0.5,1.6,0.8#ffb060' --light point:10@-1,2,0
```

| part | | |
|---|---|---|
| type | `point` \| `spot` \| `area` | spot and area lights aim at the room centre; area is 0.5 m square. There is no directional light: a room's walls would occlude it from the path tracer while the raster preview still showed it |
| `:intensity` | pt-lab's default | pt-lab's physical units — **candela** for point and spot, **nits** for area |
| `@x,y,z` | 2.2 m above the room centre | metres |
| `#rrggbb` | white | quote the whole spec — zsh with `EXTENDED_GLOB` reads `#` as a glob |

**`--light` replaces the scene's lights; it does not add to them**, and
`--no-lights` empties the set. Both mirror `--room`: nothing in the render that
the command line did not say. Anything left out of a spec is pt-lab's default,
and the ready line prints what pt-lab really applied — in the same form
`--light` takes, so it can be pasted back. A malformed spec is refused before
anything starts, because a typo read as *something* renders a plausible image
lit wrongly.

**`--lighting` multiplies every light by the same factor as the lamp.** The
multipliers are 0.5, 1.0, 2.0 and so on, doubling each time, and one image is
rendered per value. pt-lab's own intensity setting reaches only the room lamp
or environment, so with editor lights present each value would have changed the
*ratio* between the sources: shadows differing in strength from one image to
the next, not only in overall brightness. `--lighting` is meant to render the
same lighting at a different brightness, and multiplying every source by the
same factor is what keeps it to that.

Checked on a render rather than assumed: at 0.5, a 120 cd spot lights its pool
less than a 60 cd spot does at 1.0, which only holds if it rendered at 60.
Measuring the rendered pixels cannot show this — beauty renders go through ACES
filmic tone mapping, under which the lamp alone brightens 2.8× in linear terms
when the multiplier is doubled.

Lights never reach ground truth or the AOV passes. That was checked, not
assumed: the same view of `cube-1` with and without a spot and an area light
gives a byte-identical `.gt.json` and byte-identical depth, normal and albedo
passes, while the beauty render differs. What they change is **shading** — and shading is
what 111 of 123 invented segments turned out to be on the clutter scene. A light
is the lever for moving those shadow boundaries while every geometric edge stays
put.

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

**Changing pt-lab means rebuilding, and nothing else.** The alias resolves to
pt-lab's *source*, so `npm run build:generate` picks up any edit there — pt-lab
is never built on its own. `npm run check:pt-lab` type-checks it, which the
build does not. A few things do not follow that rule:

| what changed | what to run |
|---|---|
| pt-lab's `src/` | `npm run build:generate` |
| pt-lab's **assets** (the glTF model, the HDR, the denoiser weights) | `npm run build:generate` — they are copied into the bundle, so swapping one takes effect on the next build rather than immediately. That is deliberate: it pins what was rendered to what the bundle was built against |
| pt-lab gained a **dependency** | `npm install --save-dev` it here — pt-lab's dependencies are this repository's, and nothing of them is needed at run time |
| `src/generate/driver.js` | nothing — Electron requires it directly, it is not bundled |

**A method a page calls and pt-lab lacks is caught at build time.**
`src/generate/main.js` and the Scene Editor are plain JavaScript and Svelte
calling pt-lab, so a method pt-lab does not have is a runtime error rather than
a build one — the bundle builds, the app packages and launches, and `--truth`
throws the moment it is used. Two CI jobs once went green over installers in
exactly that state, when pt-lab was a sibling checkout one commit behind.
Moving it into the repository ended that case; renaming a method in one place
and not the other remains. `build:generate` ends by checking that every
`lab.<method>()` the pages call is *defined* in the bundle and not merely
called there, which is a distinction a search for the name cannot make, since
the call and the definition both end up in the build:

```
FAIL: the bundled pt-lab does not define 2 method(s) that the generator or the scene editor calls:
  - lab.exportAOVs()
  - lab.groundTruthGeometry()
…
```

Forgetting the rebuild used to be silent, and it is the worst kind of silent:
the old bundle runs and produces images that look completely reasonable, so the
symptom is "my change did nothing". `checkPrerequisites` compares the bundle's
timestamp against every file it was built from and refuses first:

```
The generator build is older than its sources.
  pt-lab/src/lib/pathtracer.ts changed after
  dist-generate/generate.js was built.
Run: npm run build:generate
```

**pt-lab is a Vite alias, not a package.** `vite.generate.config.mjs` points
`'pt-lab'` at `pt-lab/src/index.ts` and bundles its *source*; it is never
built or published on its own. Only that one config knows pt-lab exists, and
only `npm run build:generate` reads it. That is also why this is a separate
bundle: three.js and an OIDN WASM blob have no business in the app's
renderer.

**Why a custom `gen://` scheme rather than `file://`.** three.js's loaders fetch
the glTF model and the HDR environment, and **Chromium refuses `fetch()` on
`file://`** — the first attempt died with a bare "Failed to fetch". `gen://` is
registered before app-ready with `supportFetchAPI: true`, which gives a real
origin in-process: no TCP port, nothing listening. `gen://lab/` serves the built
page, and `gen://lab/assets/` serves the model, environment and denoiser weights
the build copied in beside it — which is where pt-lab's default URLs already
point.

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

**In the app you watch it happen.** The Generate frame is split: the controls
on the left, and on the right the tracer itself, converging. The main process
lays pt-lab's own web contents over that pane, so it is genuinely the renderer
rather than a picture of one.

It used to be a separate window behind a *show the render window* checkbox that
defaulted off, which meant that in practice nobody ever saw it — the checkbox is
gone and the render is simply on. Nothing about the OUTPUT depends on either
choice: `exportPNG` renders offscreen at the requested size whatever is on
screen. The CLI still has `--show`, because it has no pane to put a render in.

**The app never hosts the tracer.** pt-lab gets its own web contents loaded from
`dist-generate/`, never the renderer's; the Generate pane sends options over IPC
and says where to put the picture. That boundary is why growing the frame is
cheap — every new pt-lab control is one field in the pane and one key in the
options object, and nothing about the plumbing changes. `--scene`, `--truth`,
`--aovs` and `--denoise` all arrived exactly that way.

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

**Pixel coordinates.** In the lab, pixel *i*'s centre is at *x* = *i*: that is
how every kernel and every detection counts. The `.gt.json` files are in
pt-lab's convention, where the frame is [0, size] and pixel *i*'s centre is at
*i* + 0.5. `groundTruth` moves them by −0.5 as it reads them, so everything
compared inside the lab agrees. If you read a `.gt.json` yourself, subtract 0.5
from its x and y before comparing it with a feature record.

Results produced before 2026-10-01 compared the two unconverted. Their match
distances carry about 0.5 px per axis that was never the detector's. Gaps
between two edges were unaffected to within 0.02 px. See
`design-lab-model.md` §5, "A third, which every overlay drew and nobody saw".

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
ground-truth corners, yellow/red dots for detected ones. Where the results hold
`edge-pair` records, each pair's two edges are drawn thin, in cyan, over the
segments they came from; `--scale 8` is about what it takes to see one beside
the other.

**This is not a convenience.** A scoring table reports a number whether or not
that number is right, and both defects ever found in this machinery were
invisible in the tally and obvious in one overlay image. Pass `--min-angle` to
match whatever you gave `match`, or the picture will disagree with the table for
reasons that are nobody's fault.

### `npm run gap-sweep`

```bash
npm run gap-sweep -- --name gap-1-front --scene saved:gap-1-front
```

Steps one part toward another down to contact, renders each step with ground
truth and passes, runs `pipelines/explained.lab` over them, and writes one row
per gap to `results/<name>/gap-sweep.csv` (and `.json`), with an overlay per
step in `results/<name>/overlays/`. Only the moving part's position changes;
the camera is the scene's saved camera and the lighting is the scene's own. It
needs a GPU, and takes about 20 s per step.

The measured quantity is the gap **in the image** between the moving part's
leading edge and the target's facing edge, detected against true, taken at
the middle of where the two truth edges overlap. It is not a 6-DoF pose; the
lab has no pose estimator, and one would put its own error into the result.

| column | |
|---|---|
| `trueGapPx`, `measuredGapPx`, `errorPx`, `errorMm` | the gap, and the error; `errorMm` uses the sweep's own pixels per millimetre of gap |
| `CubeOffsetPx`, `TableOffsetPx` | the error split by edge: each detected edge against its own truth edge, positive toward the moving part |
| `refitGapPx`, `refitErrorPx`, `refitErrorMm`, `refitCubeOffsetPx`, `refitTableOffsetPx` | the same, with the two edges where `fitPairs` or `findPairs` placed them. Only when the script binds `P` or `H` |
| `gapSigma`, `stripLevel` | from that pair's record |
| `trackedGapPx`, `trackedErrorPx`, `trackedErrorMm`, `trackedSigma`, `trackedRms` | the same, read beside the line carried in by `--carry` (`trackPair`). Only with `--carry` |
| `refitFrom` | `pair`: two detected segments, placed again. `segment`: both edges found inside one detection |
| `pairFound` | both facing edges detected AND reaching the measuring point; when false, `reason` says which failed and the error columns are empty |
| `spansBoth` | detected segments lying along both parts' edges: the merge failure |
| `CubeFound`, `TableFound` | findable truth edges of each part that were found |
| `inGap_<cause>` | `explain` causes of the detections in the gap |

A detection that stops short of the measuring point is not extrapolated: a
long edge is often found in pieces, and a gap read off a piece 60 px away is an
error that looks like the detector's and is not.

`scenes/gap-1.json` rests the Cube on the Table with its front face flush with
the table's front edge, lit by the room's overhead lamp alone.
`scenes/gap-1-front.json` is the same scene with an area light on the camera
side. Under the lamp alone, the cube's own shadow takes the contrast out of
both facing edges, and no gap is measured at any step.

`scenes/stack-1.json` is a different fixture: a cube on the table and a
second, `Cube2`, the same size, lowered onto it, seen from a corner so that two
faces of each show.

```bash
npm run gap-sweep -- --name stack-1 --scene saved:stack-1 --moving Cube2 --target Cube \
                     --script pipelines/pairs.lab
```

`scenes/stack-2.json` is the same stack under a different light: low, and
between the two faces the camera sees, so that both are bright and the top
faces are dark. Under `stack-1`'s light the base cube's side and top faces are
equally bright and the edge between them cannot be seen; see
`design-lab-model.md` §5.

**A fixture with more than one facing pair gets a row for each.** The stack
has two, one down each side of its near vertical edge, and the table gains a
`pair` column numbering them left to right, with `pxPerMm` and `overlapPx`
per pair. Two edges are a pair when each is the other's nearest facing edge.
Pairs are numbered by the direction they run in the image, so pair 1 is the
same pair down a sweep even through a shot that lost the other. From a
different view the same pair may have another number.

**`--offset x,y,z` sweeps across a gap that is already open.** It adds a fixed
displacement, in millimetres, to every step, and allows negative steps. Lift
the top cube 2 mm and slide it sideways:

```bash
npm run gap-sweep -- --name stack-2-x --scene saved:stack-2 --moving Cube2 --target Cube \
    --axis 1,0,0 --offset 0,2,0 --gaps -5,-2,-1,-0.5,0,0.5,1,2,5 --script pipelines/pairs.lab
```

`pxPerMm` is then the **slope** of the true gap against the step: how many
pixels this pair's gap moves per millimetre along the sweep, signed. A pair
whose edges run along the swept direction has a slope near zero. It cannot see
that direction, and its `errorMm` is left empty rather than divided by nearly
nothing. A true gap can be negative: the moving part's edge has passed the
target's, an overhang.

**`--poses "x,y,z[,turn[,tipX,tipZ]];..."` renders a list of poses instead of
a sweep.** Each is a displacement from contact in millimetres and, optionally,
a turn about the vertical in degrees, and a tip about the x and the z axis in
degrees (the moving part's Euler rotation, about its own centre); one shot per
pose per view, named `pose-1.png` and on. The table gains `pose`, `poseX`,
`poseY`, `poseZ` and `turnDeg`, and `tipXDeg` and `tipZDeg` when any pose is
tipped.

Every row also reads the gap a sixth of the way in from each end of the pair
(`endsTruePx`, `endsDetectedPx`, and `endsPx` in the refit, in the JSON). One
number says how far apart two edges are; two say whether they are parallel,
and a part turned about the vertical opens a pair at one end and closes it at
the other.

**`--carry` holds each pair's still edge where it reads cleanly.** The still
part does not move, so its edge is one line in every frame of a view. For
every view and pair, the candidates are the frames whose refit read the pair
as two detected edges at least `--carry-min` px apart (default 3) with no
ledge in them (`fitPairs`'s `ledge.gain` under `--ledge-max`, default 1.2);
of those, the one whose still edge is the median of theirs is carried from,
so a frame that a mild ledge has moved is outvoted. Its record gives the
still edge, a point on the moving side, the strip level and the aperture, and
**every** frame of the view runs again with `K<pair> = trackPair(G, …)`: the
strip fitted where that frame read the pair `--carry-min` px wide itself, and
held at the carried level where it did not. It needs a script that binds `G`
and `P`, as `pipelines/pairs.lab` does. It works for a sweep, a sweep with
`--offset`, and `--poses`. A pair with no candidate gets nothing, and the run
says which.

```bash
npm run gap-sweep -- --name stack-2g-approach --scene saved:stack-2 --moving Cube2 --target Cube \
    --axis 0,1,0 --gaps 5,2,1,0.5,0 --yaw 35,60 --elevation 20,50 --script pipelines/pairs.lab --carry
```

**`--ledge <file>` holds a ledge in every carried pair**, from `npm run
ledge`'s table (below), matched by view and the angle a pair runs at. In
each frame the ledge ends where the still edge would be were the moving part
flush at that frame's **commanded** lift, so a frame at flush has none and
one slid back has as much as it slid; the shadow's width grows with the
lift. `--ledge-lift <mm>` places it at one lift for every shot instead, which
is what a closed loop knows (`npm run servo -- --ledge` passes its prior's).
It assumes the moving part is the one above. `--ledge-fit` adds a free ledge
fit beside each carried pair (`L<pair> = trackPair(..., ledge=fit)`), which
`npm run ledge` measures the shadow from; it is slow.

```bash
# Sweeps analysed once with free ledge fits; then the table; then every run
# re-analysed with the ledge held.
npm run gap-sweep -- --name stack-2g-x ... --carry --ledge-fit
npm run ledge -- --flush results/stack-2g-y/pairs --fits results/stack-2g-x/pairs \
    --fits results/stack-2g-z/pairs --out results/ledge/stack-2g-ledge.json
npm run gap-sweep -- --name stack-2g-test ... --carry --ledge results/ledge/stack-2g-ledge.json
```

`npm run ledge` reads two things per view and pair, with no truth. **Where
the ledge ends**: the `--flush` run (a `--carry` sweep along y with nothing
slid) gives the tracked gap as a line in the lift. **How soft the shadow is**:
the free fits in `--fits` runs where the shadow is at least `--min-lit` px
(1.5) from the still edge and fits `--min-gain` (1.5) times better than the
strip alone, as a width per millimetre of lift, the median; zero for a pair
with none. Take the widths from **sharp** images, or leave out `--fits`
and hold them at zero: under blur zero does as well as sharp widths, and
widths measured on the blurred frames themselves come out too wide and cost a
little (`design-lab-model.md` §5, "A thirty-third"). On
the stack the table takes the test poses near contact (0.6 to 2.5 mm up) from
0.114 to 0.049 mm in x. Under a lens's blur, calibrated `joint`, it takes them
from 0.120 / 0.053 / 0.074 mm to 0.079 / 0.039 / 0.029, and with it `joint`
does what `hinged` did on clean images.

The table gains the tracked columns and `gap-grid.txt` a map per gap.
`carry.json` says what was carried from where, and which pairs had nothing to
carry from; `carry-commands.json` holds
the commands, as `npm run lab -- --extra` reads them, and they are also in
each frame's session. A track is matched to a truth pair by where its line
lies, within 3 px of the target's edge. At contact, where the truth has no
facing pair, each track is a row of its own, and its gap is its error. On
the stack, tracking reads 0.5 mm (0.31 to 0.61 px) to +0.02 ± 0.02 px in six
of eight pair-views, where a frame alone read two (`design-lab-model.md` §5,
"A twelfth"), and on its test poses the still edge held takes the position
solve from 0.18 / 0.25 / 0.30 mm to 0.11 / 0.06 / 0.07 ("A sixteenth").

`--moving`, `--target`, `--axis` and `--gaps` name the parts and the steps;
the moving part's position in the scene file is contact. `--skip-render`
reruns the lab and the analysis over renders already made, and refuses if they
were made from different shots.

**`--yaw` and `--elevation` repeat the sweep from a grid of viewpoints.** Each
takes a list of degrees; every yaw is taken with every elevation. The scene's
saved camera is orbited about its own target at its own distance, with yaw 0
looking along −z and elevation measured above the horizontal. A list left out
is the saved camera's own angle. With neither, there is one view, the saved
camera exactly, and nothing about the sweep changes.

```bash
npm run gap-sweep -- --name gap-grid-1 --scene saved:gap-1-front \
    --yaw 0,20,45,70 --elevation 0,5,15,30,45,60,75 --gaps 5,2,1,0.5,0 \
    --script pipelines/pairs.lab
```

Shots are named for their view, `y20-e15-gap-2mm.png`, and the table gains
`yaw`, `elevation`, `pxPerMm` and `overlapPx` (the length the two truth
edges share). **Pixels per millimetre is per view**, because the same gap is
fewer pixels the more nearly the camera looks along it, and `errorMm` and
`refitErrorMm` use their own view's. `gap-grid.txt` holds the same numbers as
small tables, elevation down the side and yaw across the top, which is where a
pattern shows. In those, `.` means the truth has no facing pair from that view
and `-` means it has one and nothing read it. The lights stay where the scene
put them; only the camera moves.

**Renders are made with linear tone mapping by default** (`--tone-mapping
linear --exposure 0.5`), unlike `npm run generate`, whose default is ACES.
Under pt-lab's ACES curve, an edge pixel is not the midpoint of its two sides,
and edges land up to ~0.2 px off the geometry, which shows up directly as gap
bias. `gap-sweep.json` records the tone mapping read from the renders
themselves. Renders from before 2026-10-01 carry none, and are recorded as
ACES at exposure 1, marked `assumed`.

**A run name is rendered once.** Rendering into a name that already holds a
sweep is refused unless you pass `--overwrite`. Path tracing is not
byte-reproducible, so a second render replaces the images the first run's
numbers came from, and a later `--skip-render` would report different numbers
under the same name. For another sample of the same shots, use a new `--name`.

`--script <file>` runs a different pipeline over the same renders, for
example a copy of `explained.lab` with another `sigma`. It must bind `T`, `F`,
`EF` and `MF` as `explained.lab` does. Its results go to
`results/<name>/<script name>/`, so a variant never overwrites the default's.

`--script pipelines/pairs.lab` also binds `P = fitPairs(F, G)` and
`H = findPairs(F, G)`, and the table gains the refit columns: the same gap,
measured at the same point, with the two edges placed jointly against the
unblurred image. Both readings stay in the row, because the difference between
them is the blur's displacement. Where the detector found only one edge,
`pairFound` is false and the detected columns are empty, but `findPairs` may
still have a reading: on the gap sweep that is the 1 mm row.

`gap-sweep.json` records a SHA-256 of every file the lab read for each shot:
the render, its ground truth and the three passes. If a `--skip-render` finds
different ones than the previous analysis measured, it says which shots
changed and keeps the previous record as `gap-sweep.replaced-<time>.json`
instead of overwriting it. The pipeline script is recorded and checked the same
way. Under the hood it hands the generator a shot
list with `npm run generate -- --shots <file>`, which any other sweep can use.

### `npm run position`

```bash
npm run position -- --x results/stack-2g-x/pairs --y results/stack-2g-y/pairs \
                    --z results/stack-2g-z/pairs --max-views 4
```

One relative position from several gap readings. A gap is one number and a
position is three, and each pair's gap mixes two of them: lifting the top cube
and sliding it toward the camera both open the front pair's gap. Another pair,
or the same pair from another view, mixes them differently, and enough
different mixtures separate the three.

It takes three gap sweeps of one fixture, one along each axis, made from the
same `--offset` and the same views, and prints:

- **the Jacobian**: for each pair in each view, pixels of gap per millimetre
  along x, y and z, from the truth alone;
- **what each set of views is worth**: millimetres of error per axis per pixel
  of reading error, for every view alone, every two, and so on up to
  `--max-views`. One view of two pairs is always "not determined": two
  readings, three unknowns;
- **what was read**: every shot of the three sweeps is a pose whose
  displacement is known. Each is solved from the true gaps (which checks that
  a linear model is good enough), from the detections, and from the refit, and
  the RMS error per axis is reported.

`--turn <dir>` adds a fourth unknown, the turn about the vertical, from a
`--poses` run of turns at the reference offset. `--test <dir>` scores a
`--poses` run the Jacobian was not measured on, which is the honest test.
`--readings mid|ends|both` (default both) chooses where along each pair the gap
is read; a turn is only visible in the ends.

Test poses and sweep poses are scored from four kinds of reading: the truth,
the detections, the refit, and `carried`, which takes a `--carry` run's
tracked reading first, then the refit, then the detection.

`--weights sigma|none` (default sigma): each refit reading counts in
proportion to 1/`gapSigma`², the ends with their middle's. Sigma is a poor
predictor of any one reading's error, but among the readings of one pose it
is lowest where they are best; on the stack's test poses it took the turn from
0.19° to 0.05° RMS. Truth and detections are never weighted.

`--max-sigma` (default 10 mm per px) refuses a pose whose surviving readings
barely separate the axes. Plain node; it reads each sweep's `gap-sweep.json`.

**`--calibrate truth|reference|full` says where each reading's reference
and Jacobian come from** (default `truth`, the renderer's). `reference`
takes the reference from what was read, in the same mode, with the part at
the reference pose (every sweep's step 0, averaged), so a reading's steady
bias cancels; `full` also takes the Jacobian from the readings' slopes along
the sweeps, and uses no ground truth at all, as a real cell would have to. A
reading that cannot be calibrated is dropped. `joint` uses no truth either,
and fits each reading's reference and all its slopes together, by least
squares over every frame of every sweep, dropping frames more than 3 MADs off
before fitting again: a frame's error then pulls on every coefficient a
little instead of on one sweep's slope a lot. It is the one to use without
ground truth; each calibrated reading's fit scatter is in the JSON
(`calibrated[].calibration.rms`). It removes a steady bias, such
as the detections' (1.67/0.82/1.75 mm to 0.73/0.29/0.58 on the stack's test
poses), and cannot remove scatter: the refit stays at about 0.2 mm. Scatter in
the frames calibrated from is carried into every solve (`design-lab-model.md`
§5, "A fourteenth").

**`--lift <dir>` makes the slopes depend on the height** (repeatable; with
`--calibrate joint` or `hinged`). Seen from above and at an angle, a sideways
move opens a gap by an amount that depends on how high the part is, so a
Jacobian measured at one lift is wrong at another. A `--lift` run is an axis
sweep or a `--poses` run made at another lift (its own `--offset`); its frames
join the calibration, which then fits each reading's x, z and turn slopes as
changing with y -- a y·x, y·z and y·turn term -- and every solve is made with
them, iteratively, since the model is no longer linear. They are in
`--save-calibration`'s file as `lift`, and `npm run servo` uses them.

**`--tipx <dir>` and `--tipz <dir>` add tips as unknowns**: `--poses` runs
of tips about the x or the z axis at the reference offset, solved for in
degrees as `--turn` is. A tip is seen at a pair's ends, as a turn is, so
four views determine all six unknowns; but two more unknowns from the same
readings cost precision when nothing is tipped. **`--tip-prior <deg>`**
says what is known of a tip before it is seen -- zero, to that many degrees,
how level a gripper holds a part -- and weighs the readings absolutely
(`--reading-sigma` for a reading of the calibration's median gapSigma)
against it.

**`--robust <px>` reweights each pose's readings by Huber's rule**: a
reading further than that from its pose's solution keeps px/|residual| of
its weight, for five rounds. On camera-like images (noise, blur,
distortion) 0.1 px helps; on clean renders it changes nothing.

**`--sequence <dir>` solves a gap sweep frame by frame**, in the order it was
swept, twice: each frame alone, and each with the previous frame's pose
carried in. The carried pose is the last solution moved by the motion
commanded since, which a robot knows, with the last solution's covariance
grown by the move's. It enters the solve as a prior, weighed against the
readings, so a frame whose readings do not determine a pose on their own is
still solved. Repeatable.

```bash
npm run position -- --x results/stack-2g-x/pairs --y results/stack-2g-y/pairs \
    --z results/stack-2g-z/pairs --max-views 4 --sequence results/stack-2g-approach/pairs
```

The commanded poses are the true ones **with errors drawn at random**:
`--start-sigma` for the first (default 1 mm, or degrees for a turn) and
`--motion-sigma` per move (default 0.1 mm; `--turn-sigma` 0.1°). The run is
repeated `--trials` times (default 20), seeded. Fed the true poses instead,
the carried solve inherits the truth in every direction its readings cannot
see, and one view looks perfect. A first version of this did exactly that.

A prior in millimetres can only be weighed against readings in pixels on an
absolute scale, so here a reading's error is `--reading-sigma` (default
0.1 px, about what the refit scatters), scaled by its gapSigma against the
median.

For each set of views and three kinds of reading (truth; refit; and
`carried`, which takes a `--carry` run's tracked reading first), it prints:
each frame alone (frames solved, RMS), and carried, on **the same frames**
and, apart, on the frames only carrying solved. A line at the top gives the
commanded moves alone, with no camera, which is what the camera has to beat.
See `design-lab-model.md` §5, "A thirteenth", for what it found: carrying
the pose solves frames that lose their readings (contact), and does not
improve frames that read well.

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
| `edge-arc` | `fitArcs` | `id`, `pixels`, `cx cy r`, `x0 y0 x1 y1`, `angle0`, `angle1`, `sweep`, `arcLength`, `chord`, `sagitta`, `residual`, `rms`, `lineRms`, `mx my` |
| `edge-track` | `trackPair` | `id`, `still` and `moving` (each `x0 y0 x1 y1`), `toward`, `gap`, `gapSigma`, `model` (`strip` or `edge`), `ratio`, `freeRatio`, `levels`, `levelSlopes`, `strip`, `stripLevel`, `aperture`, `rms`, `samples`, `iterations`, `converged` |
| `edge-pair` | `fitPairs`, `findPairs` (which adds `gain`) | `id`, `a` and `b` (each `segment`, `x0 y0 x1 y1`, `shift`), `x y`, `nx ny`, `gap`, `gapSigma`, `detectedGap`, `levels`, `levelSlopes` and `ledge` (fitPairs only), `strip`, `aperture`, `apertureFrom`, `apertureSegments`, `rms`, `samples`, `iterations`, `converged` |
| `edge-corner` | `corners` | `id`, `x y`, `support`, `segments`, `sigma`, `reach`, `endpointGap`, `angle` |
| `gt-edge` | `groundTruth` | `id`, `cause`, `objects`, `x0 y0 x1 y1`, `z0 z1`, `length`, `angle`, `dihedral`, `visible`, `clipped`, `v0 v1` |
| `gt-vertex` | `groundTruth` | `id`, `x y z`, `degree`, `visibleDegree`, `onFrame`, `visible`, `angle`, `objects` |
| `edge-match` | `match` | `id`, `kind`, `role`, `detected`, `truth`, `cause`, `objects`, `distance`, `angleDiff`, `x y` |

`kind` is `segment`, `arc` or `corner` — which of the three detectors the
verdict is about.

`role` is `hit`, `false-positive` or `miss`. Join a match record back to the
feature it judged by `detected` — that is how the evidence and the verdict come
together.

**`id` is the label's, not the record's.** `fit` and `fitArcs` read the same
label map, so a segment and an arc describing one label carry the same `id`.
Join on the type as well as the id, or two different descriptions of one edge
will collide.

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
- **Recall is per feature list, and the lists overlap.** `fit` and `fitArcs`
  describe the same label map, so an edge found by a segment is counted as
  missed by the arcs and the other way round. Nothing builds one list from
  both, so a combined recall cannot be computed. Precision is the column that
  means what it says.
- **Nothing reads a gap under about a pixel on its own.** `findPairs` finds a
  1.16 px gap inside a single detection and reads it 0.25 px short; at
  0.58 px it finds nothing, and nothing tells contact from a gap that small.
  Holding the strip's level helps, and nothing carries that level from one
  frame to the next for you.
- **A hidden strip between its neighbours in brightness is not found.** It is
  indistinguishable from one soft edge.
- **Ground truth models geometry, so an image-space T-junction is scored as an
  invention.** Where two real occluding contours cross, the picture has a
  corner and the scene has no vertex — nothing touches there. `explain` makes
  these visible (they come back `occlusion` while matching nothing) but the
  truth cannot represent them, so corner precision on a scene with more than
  one object reads lower than the detector deserves.
- **Bit-exactness holds within a machine and across the three supported
  platforms**, for the geometry and for every buffer this pipeline currently
  produces. It does **not** hold across compiler versions or optimisation
  levels — treat those as new provenance. `gaussian` still calls `exp`,
  `toLinear`/`toSrgb` call `pow`, and `orient` calls `atan2`; all three write
  `f32` and all three currently agree across the matrix, which is margin rather
  than proof.
