# cv-lab-2: The Lab Model

How the application is organised from the user's point of view, and the data
model underneath it.

Unlike `electron-guide.md`, which records things learned by doing them, this
document is written **before** the work. Treat its claims as decisions, not
findings — and correct it when reality disagrees.

**Two requirements drive almost everything here:** the lab must handle
**non-8-bit data**, and results must be **reproducible**. Several choices below
would be different if either were relaxed.

Unfamiliar term? See [`glossary.md`](glossary.md).

---

## 1. The core model

Three concepts. Keeping them separate is the central decision of the design.

| Concept | What it is | Named |
|---|---|---|
| **Buffer** | Raw pixel data: `width, height, channels, dtype, space`, plus the bytes | — |
| **Slot** | A named container holding one buffer *or feature list*, plus its provenance | `A`, `B`, `edges`, … |
| **View** | A tile displaying one slot, with a non-destructive display transform | — |

All slots are identical in kind. There is no "input canvas" and no "result
canvas" — any slot can hold any image, and operations read and write them
interchangeably. Slots are created by the user (or implicitly, on assignment),
so there is no fixed number to get right.

### Three output kinds

An operation produces one of three things, and the distinction reaches into the
session, the log and the display:

| Kind | What it is | Binds to a slot? |
|---|---|---|
| **`buffer`** | pixels — the common case | yes |
| **`features`** | geometry: line segments with endpoints, angles, lengths | yes |
| **`scalars`** | a measurement, like `stats` | no |

**Every feature record carries a `type`**, namespaced: `edge-segment` and
`edge-corner` today. The prefix is deliberate — a future region, blob or flow
feature must not collide with an edge one merely by both wanting the word
"corner".

Two defects came from omitting it initially, both silent. Feature hashing used
a key list written for line segments, so corner records — which share only `id`
and `angle` — all collapsed onto the same hash: two entirely different sets of
corners were indistinguishable, which is worse than having no hash, because a
matching hash is supposed to mean matching results. And the overlay drew every
feature as a line, so corners produced `NaN` coordinates that canvas silently
discards — computed, logged, and invisible.

The hash now sorts and includes *every* field of *every* record rather than a
list someone maintains, because a hardcoded list silently drops whatever it was
not written for.

`features` exists because a line segment is not an image. Everything up to
`segments` answers *which pixels belong to which edge*; `fit` answers *what
each edge is*, and that answer has no pixels, no dimensions and no colour
space.

It was added late and deliberately. Everything before it stayed inside the
buffer model, which is why the change was contained: about fifteen sites across
four files, and no existing operation, kernel or saved session became wrong.
The load-bearing assumption was a single line —
`const producesBuffer = op.output.kind !== 'scalars'` — the boolean form of
"anything that is not scalars is a buffer", which is exactly what a third kind
invalidates.

Feature lists carry the **dimensions of the image they were measured in**,
because they have none of their own. That is what lets the display draw them
over the right tile, and it is why they get no tile of their own: a segment
list belongs *on* a picture, not beside one.

### Why slots are not canvases

A `<canvas>` can only hold 8-bit RGBA. That is fine for display and wrong for
computation:

- A Sobel response has **negative values**.
- A distance transform is **floating point**.
- An integral image **overflows** 8 bits immediately.
- A connected-components label map wants **int32**, and interpolating it is
  meaningless.

If slots were canvases, every stage of a pipeline would be forced through
`Uint8ClampedArray`, and a pipeline like `blur → sobel → threshold` would
silently clamp away half the gradient response. So slots hold typed buffers,
and canvases exist only inside views, as the surface a buffer is *rendered to*.

This preserves the uniformity that motivated the design — all slots alike, all
tiles alike — while letting the display format stop dictating the computation
format.

---

## 2. Buffer format

### f32 is the working format

Supporting `u8`, `u16`, `i16`, `i32` and `f32` throughout would multiply
against every kernel: the same Sobel written five times in C. Instead:

- **`f32` is the working dtype.** Everything computes in it.
- **`u8` appears only at the boundaries** — image decode on load, and the RGBA
  conversion at display time.
- **`i32` is the one deliberate exception**, for label maps, where exact
  integer identity matters and interpolation is nonsense.

Cost: a 12 MP single-channel `f32` buffer is 48 MB — the same as 12 MP RGBA
`u8`. Memory is not the constraint here; developer time is. Production CV
libraries support many depths because memory bandwidth is their bottleneck.
That is not this project's bottleneck.

### Color space is part of the buffer

Every buffer carries a `space` field: **`srgb`** or **`linear`**.

A value stored in an image file is not proportional to light — it is
gamma-encoded, so that 8 bits can be spread to match human perception. That
makes two pixel arrays with identical numbers mean different things, and there
is no way to tell them apart by inspection. See
[`glossary.md`](glossary.md) for the transfer function and the worked example.

Why it has to be tracked rather than assumed:

- **Operations that mix pixels need `linear`** — blur, resize, alpha blending,
  any convolution whose positive weights sum to 1. Averaging gamma-encoded
  values averages in the wrong space and comes out too dark.
- **Operations that only compare or rank values do not care** — threshold,
  median and other rank filters, connected components. A monotonic transfer
  function does not disturb ordering.
- **Gradients are *different*, not wrong.** Sobel on `srgb` emphasises edges in
  dark regions more than the same operator on `linear`. Much of classical
  computer vision runs on gamma-encoded images quite happily. The result is a
  different measurement — which is exactly why the lab must record which one it
  made.

So: operations declare the space they require in the registry, and the session
**refuses** rather than silently computing the wrong thing. The first operation
where this bites is `gray`, because the familiar luminance coefficients
`0.2126 R + 0.7152 G + 0.0722 B` are valid **only** on linear values; applied
to `srgb` values they produce luma, a different quantity.

**Declaring is not enforcing.** This was written before it was implemented, and
the first version of `gray` shipped with the requirement declared in the
registry and checked nowhere — it computed luma on sRGB input and reported it
as luminance. Exactly the failure this section exists to prevent, silently, for
one commit. The check now lives in `Session._apply`, and a refused command
appends nothing to the log.

**Refuse, not convert**, in the end. An earlier draft of this section said
"converts or refuses". Auto-conversion loses: it would insert processing that
never appears in the log, and the log explaining the result is this project's
whole claim. Instead the refusal is actionable —

```
gray needs linear input, but S#1 is srgb. Convert it explicitly: X = toLinear(S)
```

— and `toLinear` / `toSrgb` are real operations that appear as entries.
`space: 'none'` satisfies any requirement: a gradient or a mask is not a
colour, so the question does not apply to it.

`space` is recorded in provenance alongside dimensions and dtype (§5). "Which
space was this computed in" is precisely the sort of question a reproducible log
exists to answer.

Note that working in `linear` throughout carries no precision cost here, since
the working format is `f32`. The usual objection — banding in 8-bit linear —
does not apply. §11 records which of the two policies remains open.

### Layout: interleaved

Pixels are stored `(y, x, c)` interleaved, matching canvas RGBA order.
Cache-friendly for per-pixel operations, and it keeps the display path simple.

Planar `(c, y, x)` is better for per-channel SIMD. If a specific kernel needs
it, convert locally inside that kernel rather than changing the global format.

### Value convention: intensity is 0.0–1.0

`u8` 200 loads as `200/255 ≈ 0.784`, not `200.0`.

Either convention works; ambiguity does not. 0–1 keeps filter coefficients,
blend factors and gamma handling predictable, and makes "is this normalised?"
a question with a permanent answer.

Derived data is not bound by this — a gradient magnitude may exceed 1, a
signed gradient may be negative. That is expected, and it is what the display
transforms in §6 exist to handle.

---

## 3. Operations and the registry

Every operation is one entry in a registry:

```js
{
  name: 'sobel',
  version: 1,
  inputs: [{ name: 'src', channels: [1] }],
  params: [
    { name: 'axis', type: 'enum', values: ['x', 'y', 'mag'], default: 'mag',
      semantic: true },
    { name: 'preview', type: 'bool', default: false, semantic: false },
  ],
  output: { channels: 1, dtype: 'f32' },
  cancellable: true,
}
```

The registry is the single source of truth for:

- the operation dropdowns and their parameter forms
- validation in the command parser, and its error messages
- generated documentation
- the **shape** of a provenance record (see below)

Adding a kernel is one registry entry plus one C function — not edits scattered
across four files.

### What the registry contributes to the log

There is no `record:` field, and the registry is **not itself written into the
log**. Its contribution is to define what a record must contain and how to
normalise it. A log entry is:

```
op name  ·  op version  ·  fully-resolved semantic params  ·  input (slot, version) refs
```

The registry supplies the first two, and the parameter schema needed to produce
the third.

**Defaults must be resolved at record time.** The user types `sobel(B)`; the
log must store `sobel(B#2, axis=mag) [v1]`. If only the typed text were kept
and a later version changed the default from `mag` to `x`, replaying an old
session would silently produce different pixels. This is the single most
important rule in this section — it is cheap to get right and produces
untraceable results when got wrong.

**`semantic: false` marks parameters that do not affect output** — preview
quality, display hints, progress granularity. They are excluded from the log
and from any cache key, so toggling them never invalidates a result or
perturbs a hash comparison. Anything unmarked defaults to semantic; opting
*out* should be a deliberate act.

**Bulk parameters are recorded by hash, not by value.** A custom convolution
kernel passed as an array goes into the log as `kernel=sha256:1f9c…` with the
array stored alongside the session, so a log line stays a line.

**`version` matters because reproducibility does.** When a kernel's behaviour
changes, bump it. Old session logs then record which version produced them,
and a replay that produces different pixels has an explanation rather than a
mystery.

What is *not* recorded per entry, because it belongs to the session as a whole:
the application version and the addon build identity (see §5).

### How big should an operation be?

**Default to the smallest stage whose output is worth looking at.**

The question arrives with the first multi-stage algorithm and never goes away.
Canny is the worked example: it is five stages, and it could be one operation
or six.

```
B  = gaussian(A, sigma=1.4)
Gx = sobel(B, axis=x)
Gy = sobel(B, axis=y)
M  = sobel(B, axis=mag)
N  = nms(M, Gx, Gy)
E  = hysteresis(N, low=0.01, high=0.04)
```

versus `E = canny(A, sigma=1.4, low=0.01, high=0.04)`.

**Staged wins, for three reasons specific to a lab:**

- **You can see the middle.** Looking at `N` shows what non-maximum suppression
  actually did. That is frequently the answer to "why are my edges wrong" — and
  a monolithic operation makes it unobservable.
- **You can re-run one stage.** Changing `low` re-runs `hysteresis` alone. With
  a wrapper, every threshold tweak recomputes the blur and three convolutions.
- **The log explains the result.** Seven entries describing what happened, not
  one entry saying `canny` and leaving the reader to guess which variant.

**What it costs**, stated honestly: three `sobel` calls convolve the same
blurred image three times, which a fused implementation would do once. At lab
scale that is milliseconds. If it ever stops being milliseconds, fuse *then* —
and only with a benchmark saying so.

**When a wrapper is the right call:** when the intermediates are genuinely
meaningless on their own, or when fusing is required for performance rather
than merely tidier. Neither applies to Canny.

### If a convenience wrapper is added later

Add it as a **macro that expands into the stage commands**, not as a kernel
that hides them. Typing `canny(A)` would append the six entries above to the
log, exactly as if they had been typed.

That keeps both properties at once: one thing to type, and provenance that
still explains itself. A wrapper implemented as its own kernel would produce a
single opaque entry and quietly undo the reason for staging in the first place.

The stages are the primitive; convenience is sugar over them, never a
replacement.

### Purity

Operations allocate their output by default. `A = blur(A)` is allowed but is
implemented as allocate-then-swap, not in-place mutation — in-place kernels and
provenance tracking do not mix comfortably. Where memory genuinely demands it,
add an explicit in-place variant and mark it in the registry.

### Cancellation

Every kernel takes a cancellation flag it polls periodically, **from the first
kernel written**. Retrofitting cancellation into twenty existing kernels is
miserable; adding it to one costs nothing. The UI for cancelling can come
later; the parameter cannot.

### Validating inputs is a security requirement, not tidiness

A native addon adds an attack surface a pure-JavaScript app does not have.
Image-processing code written in C, parsing input somebody else supplied, is
historically one of the richest sources of remote code execution there is — a
buffer overflow while handling a malformed image hands an attacker control of
the process. `CVE-2023-4863`, the WebP heap overflow exploited in the wild
against Chrome and most software that decodes WebP, is exactly this shape.

This project will open files it did not create, and eventually session files
and images from other people. So every kernel treats its inputs as hostile:

- **Check dimensions before allocating.** `width * height * channels` overflows
  a 32-bit integer at moderate image sizes, yielding a buffer far smaller than
  the code then writes into. Compute sizes in `size_t`, and reject implausible
  dimensions up front rather than trusting the caller.
- **Bounds-check rather than trusting a supplied length.** `native/addon.c`
  already rejects a pixel count that is not a non-zero multiple of 4; that is
  the pattern, not an exception to it.
- **Fuzz the kernels** with malformed and adversarial input once there are
  several. Cheap to automate, and it finds the class of bug that code review
  reliably misses.

The rule of thumb: a crash in C is not merely a crash. It is the first half of
an exploit.

---

## 4. The command language

Deliberately tiny:

```
A = load("samples/board.png")
B = gaussian(A, sigma=1.4)
C = sobel(B, axis=mag)
D = threshold(C, 0.2)
// comments, so scripts document themselves
```

Grammar: `name = op(arg, ...)`, where an argument is a slot name, a number, a
string, or `key=value`. Slots are created on assignment.

**Explicitly not included:** control flow, arithmetic expressions,
user-defined functions, variables that are not slots. If loops are ever needed,
embed an existing scripting engine rather than growing this into a language.
That path is well-travelled and it ends badly.

### The GUI writes commands

The dropdown controls do not call operations directly. They **compose a command
string, insert it into the log, and execute that**. Consequences:

- One execution path, so the GUI and scripts cannot diverge.
- Everything done through the UI is automatically recorded and replayable.
- Users learn the command language by using the interface.

This is what ImageJ's macro recorder does, and it is the most-loved thing
about it.

---

## 5. Reproducibility

### One log; slot provenance is a view over it

There is a single append-only **session log**. Slots do not each own a private
history — a slot's provenance is the sub-graph of log entries it depends on,
derived on demand.

```
#1  A ← load("samples/board.png")            sha256:9f2c…  4243×2829×1 f32 srgb    [v1]
#2  B ← gaussian(A#1, sigma=1.4)             sha256:31ab…  4243×2829×1 f32 linear  [v1]
#3  C ← sobel(B#2, axis=mag)                 sha256:c740…  4243×2829×1 f32 linear  [v1]
#4  D ← threshold(C#3, t=0.2)                sha256:0e55…  4243×2829×1 i32 —       [v1]
#5  E ← overlay(A#1, D#4, alpha=0.5)         sha256:aa13…  4243×2829×3 f32 linear  [v1]
```

Reading that back:

- **A slot participates in many commands, but exactly one command *produced*
  each version of it.** `A#1` is produced by `#1` and consumed by `#2` and
  `#5`. "The command that produced it" is singular and correct; "the commands
  it took part in" is a different and larger set.
- **A slot's provenance is therefore a chain, not a line.** `E`'s provenance is
  the transitive closure `{#5, #1, #4, #3, #2}` — a DAG, since `A#1` is reached
  by two routes.

### Slots are versioned; log entries are immutable

`A = blur(A)` does not mutate `A#1`. It appends an entry producing `A#2`, and
rebinds the name. The old buffer may be freed, but the *entry* never changes,
so anything referring to `A#1` still means what it meant.

The useful analogy is git: **log entries are commits, slot names are refs.**
Names move; history does not.

This is why references are `(slot, version)` pairs rather than bare names. A
provenance chain built from bare names would be ambiguous the moment a slot was
reassigned.

### Reading a fitted segment

`fit` reports, per segment: `id`, `pixels`, `x0 y0`, `x1 y1`, `length`,
`angle`, `residual`, and the centroid `cx cy`. Two of those need their
conventions stated, because both are easy to read wrongly.

**`angle` is measured from horizontal, anticlockwise, in image coordinates —
where y increases DOWNWARD.** So the sense is inverted from graph paper:

| Angle | The line runs | On screen it looks |
|---|---|---|
| 0° | right, same row | horizontal |
| 45° | right and down | **descending** to the right |
| 90° | down a column | vertical |
| 135° | right and up | **ascending** to the right |

Reported in `[0, 180)`, because a line has no direction: 10° and 190° describe
the same line.

**`residual` is the largest PERPENDICULAR distance from any of the segment's
pixel centres to its fitted line, in pixels.** Perpendicular is the point —
that is what makes it total least squares rather than ordinary least squares,
which measures vertically and misbehaves on near-vertical edges. It is a
maximum rather than a mean, so it is a guarantee: no pixel lies further out
than this.

Measured on constructed cases:

| | residual |
|---|---|
| a perfectly straight run | 0.000 |
| a one-pixel zigzag | 0.564 |
| a single one-pixel step | 0.461 |
| a 45° bend halfway along | 2.242 |

Real segments from a rendered cube run 0.00–0.83 — quantisation noise from
drawing a straight line onto a pixel grid, nothing more. `maxResidual = 1.0`
is the gate that admits those and rejects the bend.

**Endpoints are projected onto the fitted line**, not reported as the extreme
pixels themselves. That is where sub-pixel accuracy comes from: the line is an
average over every pixel in the segment, so it localises better than any single
pixel centre can.

### Cost, measured

Timings on a checkerboard, which is close to a worst case — every block
boundary fragments, so the segment count is far above what a photograph
produces. `pattern(kind=checker)` at each size, `gaussian(sigma=1.4)`, then
`segments(minPixels=3)` and defaults elsewhere:

| image | segments → merged | pixel stages | `segments` | `merge` | `fit` | `corners` |
|---|---|---|---|---|---|---|
| 256² | 2,015 → 1,518 | 2 ms | 1 ms | 33 ms | 2 ms | 0.3 s |
| 512² | 8,127 → 6,110 | 9 ms | 6 ms | 526 ms | 10 ms | 5.5 s |
| 768² | 18,335 → 13,774 | 20 ms | 14 ms | 2.7 s | 22 ms | 30.1 s |
| 1024² | 32,639 → 24,510 | 35 ms | 26 ms | 8.5 s | 39 ms | 125.1 s |

**State the parameters.** An earlier version of this table gave segment counts
without saying what produced them, and they could not be reproduced: at the
*default* `minPixels=8` this pipeline finds **zero** segments at every size,
because `pattern`'s checkerboard draws 8-pixel blocks and no run of one
survives a blur and non-maximum suppression. A cost table whose inputs are not
written down is a number nobody can check.

**The pixel stages are not the cost.** Blur, gradients and thinning together
are 35 ms on a megapixel. Everything expensive is quadratic in the number of
*segments*, which is a property of the scene rather than the resolution.

`merge` was 100× worse than this until the pixel index went in: three loops
scanned the whole image per segment or per candidate pair, making it
O(segments² × pixels). It took four minutes on 768² and never finished at
1024². Building the index once turned it into O(segments²), which the ratios
confirm — a 1.78× rise in segments now costs 3.18×, against 3.18 predicted.

**`fit` had the same defect and kept it for two more commits.** It scanned the
whole image once per segment to collect that segment's pixels — O(segments ×
pixels) — costing 7.7 s at 1024² against the 84 ms this table used to claim.
The number was wrong and nobody re-measured it, which is how a fix applied to
`merge` failed to reach the identical loop one file away. Both now call
`cv_label_index`, one shared function, so a third consumer of a label map
cannot repeat it. Measured after: 39 ms, and linear in segment count.

`corners` is now unambiguously the wall, and this table used to understate it
by roughly 45×. It is quadratic in segments and its clustering pass is
quadratic again in candidates, which is what the 4× rise in segments costing
23× between 512² and 1024² reflects. **Two minutes on a megapixel of
checkerboard.** Nothing above a few thousand segments is interactive, and any
batch run should watch the segment count rather than the resolution.

### Corners are hypotheses, not detections

`corners` intersects fitted segments pairwise. What it deliberately does *not*
do is decide which intersections are real.

**Real edges systematically stop short of their corners**, and for three
measured reasons: blur rounds the vertex so the gradient direction rotates and
`segments` stops growing; non-maximum suppression deletes junction pixels
outright (21% of the cube's edge pixels had four neighbours, and a checkerboard
mask has literal gaps where lines cross); and weak ends fall below `minMag`.
A gap between a segment's end and a true corner is the normal case, so a fixed
pixel threshold is wrong for half of any image.

So each candidate carries the evidence instead, and a later stage can spend
effort only where the geometry says it might pay off:

| Field | What it measures |
|---|---|
| `support` | how many segment pairs agree at this location |
| `endpointGap` | how far apart the two edges' **nearest ends** actually are |
| `reach` | how far past its own end each line had to be **extended**. Negative means they genuinely cross |
| `sigma` | propagated positional uncertainty, in pixels |

`endpointGap` and `reach` sound similar and ask different questions. `reach`
measures how far a line was *extended*; two unrelated lines can each be
extended a long way and still meet somewhere perfectly precise and entirely
meaningless. `endpointGap` measures whether the two edges actually **stopped
near each other**, which is what "they meet here" physically means. A corner
eroded by blur and non-maximum suppression leaves both edges terminating a few
pixels short of it, so their ends stay close even when the extrapolation is
long.

`sigma` comes from the fits rather than from a guessed weighting. A TLS fit
over *n* pixels of length *L* with RMS residual *s* has angular slop of about
`s·√12 / (L·√n)`; extrapolating a distance *d* smears the endpoint by `d·δθ`;
and two lines crossing at angle θ combine as `√(e₁²+e₂²)/|sin θ|`. Which is why
`fit` reports `rms` as well as the maximum `residual` — the maximum is a
guarantee about the worst pixel, the RMS is what propagation needs.

**`sigma` measures precision, not correctness** — which is true, and was taken
too far here. On the cube, all fourteen candidates located to better than one
pixel, including nonsense at 92 px of reach: two long, clean, well-determined
lines extended a long way do intersect *precisely*, somewhere that is not a
corner. An earlier version concluded from that `sigma` says how well-located an
answer is once you already believe it, and nothing more. Over twenty-four views
it is nearly as good a discriminator as `endpointGap` and the two together are
much better than either — because most invented corners come not from long
clean lines but from short fragments, which `sigma` is built to be sceptical
of. The measurement is below. `support` is the field that turned out to carry
nothing, and **`reach` remains the weakest** of the three continuous ones.

### What the cube measured

Fourteen candidates from nine segments. Seven are real, and a cube in general
position has exactly seven visible vertices — four where three edges meet and
three where two do, giving the nine edges a degree sum of eighteen.

| | `endpointGap` | `reach` |
|---|---|---|
| the seven real corners | **1.3 – 3.5** | 1.1 – 33.2 |
| the seven spurious ones | **49.2 – 65.4** | 46.4 – 92.1 |

`endpointGap` separates them with a **14× margin and no overlap**. `reach` does
not: two of the genuine three-way vertices reach 33.2 and 22.2 px, inside the
spurious range, because a corner can lie well past the far end of one of the
edges that meets there.

That was an error in an earlier version of this section, which named `reach` as
a discriminator. It measures how much geometry was invented, which is worth
reporting; it is not what tells you whether the corner is real.

**Caveat**: one image, of a synthetic cube, with clean edges. The margin is
striking and it is a single data point. Re-check before relying on it.

That re-check has now happened, against ground truth, over twenty-four views.
**The separation does not survive it** — see below. The table above is left
standing because it is what that image really measured.

### Ground truth: asking the renderer instead of arguing

Everything above was measured by reading one picture. That is how the `reach`
error got in, and it is a bad way to settle a claim about a detector.

A photograph does not come with a list of where its edges are. A **render**
does: the mesh, the camera and the transform are all sitting there, so where a
cube's twelve edges land in the image is arithmetic — and arithmetic again for
the next pose, a thousand times, at no cost. So `pt-lab` was asked for it, and
answers in two forms:

| | What it is | Cost |
|---|---|---|
| **AOV passes** | depth, surface normal and unlit albedo for the view | one raster frame |
| **Projected geometry** | every silhouette, crease and mesh-boundary edge in image space, with how much of it is visible, and the vertices they meet at | one raster frame plus arithmetic |

The passes decompose *why* an edge is in the picture — a depth step is an
occlusion, a normal step with no depth step is a crease, an albedo step with
neither is texture, and an edge with none of the three belongs to the lighting.
The projected geometry is what answers the corner question, and it has to be
geometry rather than a pass: **a corner is a point**, and extracting points
from an edge image is the problem under test, so a raster ground truth would
grade the pipeline against a second implementation of the same guesswork.

**The AOV passes are not colour, and the lab must be told so.** They carry raw
linear code values, so `pt-lab` writes them with no colour chunks at all,
deliberately — an sRGB tag would invite a decoder to apply a curve that was
never there. `readPngColour` returns `undeclared` and the sRGB convention takes
over, silently and nonlinearly wrong. They must be read `from=linear`. This is
the same hazard §11 records for `gAMA 1.0` files, arriving through the door
nobody was watching.

**It is two ordinary operations**, not a side channel: `groundTruth` reads the
renderer's JSON into `gt-edge` and `gt-vertex` features, and `match` scores a
detected list against it. So the comparison lands in the log with its
parameters resolved and its result content-hashed, exactly like a blur.
`groundTruth` also demonstrates why feature types are namespaced (§1): `match`
sends `edge-segment` to the edges and `edge-corner` to the vertices by reading
what the records say they are.

#### What ground truth cannot settle

Three limits, and they are not fine print. Every number below has to be read
with all three in view.

- **A geometric edge need not be a visible one.** Two walls meeting under flat
  lighting produce no gradient at all. Failing to detect it is not a failure.
- **A visible edge need not be geometric.** Shadow boundaries, specular
  terminators and texture are real image edges and none of them are in the
  ground truth. On the cube, the strongest unmatched detection in several views
  is the shadow the cube casts — a correct detection of something that is not a
  shape.
- **The ground truth resolves what the image cannot.** The table top is 5 cm
  thick, which is two edges in the model and one line in the picture.

So a match rate says *how much of what the pipeline found is explained by
geometry*, not *how often the pipeline is right*. Recall in particular is a
floor, not an estimate.

#### Two defects, both found by looking rather than by reading

Worth recording because in both cases the table was perfectly plausible.

**A tolerance tuned on a degenerate fixture.** The renderer's visibility test
reported 22% of a cube's hidden back edge as visible, so its slope tolerance
was made robust — and measured against a view whose answer is known, the fix
was strictly worse: two genuinely visible edges fell to 0.42 and 0.49. The 22%
was the fixture. That first view had the camera at yaw 0 on an axis-aligned
cube, so the hidden back edges projected *exactly onto* the visible silhouette
edges and no test at any tolerance could have separated them. The cube scene
now offsets every yaw by 0.35 rad for that reason alone.

**Recall asked from the wrong side.** Scoring credited, per detection, the
single nearest ground-truth edge — so one fitted segment lying down the middle
of twelve facets of a ball's silhouette scored one found and eleven missed.
Recall read 40%. Precision walks the detections and recall walks the ground
truth; they are not each other's inverse, and one pass cannot do both. 65%
after the fix.

Neither shows up in a scoring table, which reports a number either way. Both
were obvious in one overlay image, which is what `npm run overlay` is for.

#### What twenty-four views measured

`--scene cube --positions 12 --lighting 2`, 256 px, 160 samples, denoised;
`pipelines/geometry.lab` at its defaults; matched at 3 px and 20°. 372 segments
and 661 corner candidates in total.

|  | detected | real | invented | missed | precision | recall |
|---|---|---|---|---|---|---|
| segments | 372 | 252 | 120 | 204 | 68% | 55% |
| corners | 661 | 162 | 499 | 36 | 25% | 82% |

**25% precision at 82% recall is `corners` working as designed**, not failing.
It is specified to produce hypotheses and leave the deciding to a later stage,
so it finds nearly every real corner and invents three for each one. The
question was never whether that ratio is good; it is whether the evidence each
candidate carries can sort them. Now measurable:

| field | keep | real | invented | best F1 | at |
|---|---|---|---|---|---|
| `endpointGap` | below | p50 **2.04**, p90 3.52, p99 18.07 | p1 0.83, p10 2.78, p50 27.29 | **0.80** | 3.9 px |
| `sigma` | below | p50 0.11, p90 0.21 | p1 0.09, p10 0.15, p50 0.38 | **0.76** | 0.14 px |
| `reach` | below | p50 3.09, p90 16.59 | p1 0.86, p10 4.55, p50 22.29 | 0.70 | 6.5 px |
| `support` | above | p50 1, p90 3 | p50 1, p90 2 | 0.40 | ≥2 |
| `angle` | above | p50 70.0 | p50 67.7 | 0.40 | — |

**Three corrections fall out of that table, and one thing holds.**

**`endpointGap` is still the best single field, and it does not separate
cleanly.** At 3.9 px it keeps 92% of the real corners at 71% precision, which
is useful and is not the fourteen-fold gap with no overlap that one image
showed. Real corners run to 18 px at the 99th percentile and invented ones
start at 0.83.

**`sigma` is a discriminator, and this document said it was not.** The claim
above — *`sigma` says how well-located an answer is once you already believe
it* — was reasoned from a true observation: two long clean lines extended a
long way do intersect precisely. What it missed is that most invented corners
do not come from long clean lines. They come from short fragments extrapolated
a long way, and those have large `sigma` for exactly the reason `sigma` exists.
On the cube's nine long segments the field carried no information; across
twenty-four views averaging fifteen segments each, it very nearly matches
`endpointGap` on its own.

**Together they are much better than either alone:**

```
endpointGap <= 7 px  AND  sigma <= 0.2 px      F1 0.89   precision 94%   recall 84%
endpointGap alone                              F1 0.80   precision 71%   recall 92%
sigma alone                                    F1 0.76   precision 73%   recall 78%
```

They are close to independent, which is why: one asks whether the two edges
stopped near each other, the other asks whether the fit was well enough
determined to be extrapolated at all. **94% precision from two numbers that
cost nothing** is the headline result of the whole exercise.

**`support` contributes nothing.** This document names it alongside
`endpointGap` as separating real from invented. It does not: F1 0.40 alone, and
adding it to the pair above leaves the best combination at `support >= 1`,
which is every candidate. Three edges meeting at a vertex do agree — but a
cube's silhouette vertices have only two, and coincidental agreement between
unrelated extrapolations is common enough to cancel the signal. Worth reporting,
not worth thresholding.

**`reach` remains the weakest of the three continuous fields**, which is the one
thing here that confirms rather than corrects: F1 0.70 against `endpointGap`'s
0.80, and its real and invented distributions almost coincide below 5 px.

**Caveat, again, and it is a different one this time.** Twenty-four views of one
synthetic cube under one lighting sweep. The poses vary and the subject does
not, so this measures a detector against *a cube*, well. It says nothing yet
about a photograph, and the thresholds above are certainly tuned to this scene.

### The expensive follow-up, and why it may never be needed

The obvious next step was to go back to the image and test a hypothesis: check
whether gradient magnitude is elevated along an extrapolated path, or re-run
`segments` locally with a lower threshold near a predicted corner. A separate
operation consuming corners, so that it runs only where a hypothesis already
exists.

**It has not been built, and on present evidence it is still not needed —
though the evidence has changed underneath that sentence.** It used to read
that `endpointGap` separated real from spurious *perfectly*, on the one image
tested. Twenty-four views say it does not: 71% precision on its own. What
rescues the conclusion is that pairing it with `sigma` reaches **94% precision
at 84% recall**, and both numbers are already sitting in the record. Spending
an image pass to recover information that costs nothing would still be the
wrong trade — but that is now a claim about a two-field test rather than a
one-field one, and the margin is 94% rather than "perfectly".

What would justify revisiting it: a case where two edges genuinely meet but
both erode so far back that their endpoints are no longer near each other.
Heavy blur, a low-contrast junction, or a corner where three edges converge so
steeply that non-maximum suppression removes a long stretch of all of them.
If that turns up, the follow-up is the answer and this note explains why it was
deferred rather than forgotten.

### Two directions

| Direction | Question it answers | Used for |
|---|---|---|
| **Backward** (ancestry) | how was this made? | reproducibility, replay, export metadata |
| **Forward** (consumers) | what did this feed? | staleness — "I changed A, what is now out of date?" |

Backward is the one reproducibility needs and the one to build first. Forward
falls out of the same graph read the other way, and is what a future
recompute-downstream feature would use.

### Where it is persisted

| When | Where |
|---|---|
| during a session | in memory, alongside the slot table |
| continuously | appended to an autosave journal, so a crash does not lose the history |
| on save | a session file: the log, plus source paths with their content hashes, plus any bulk parameter blobs |
| on image export | a sidecar `.json` — or embedded metadata — carrying the ancestry of just that slot |

Recorded **once per session** rather than per entry: the application version
and the addon build identity. Compiler version and optimisation level change
floating-point results (see the determinism rules below), so a replay under a
different build is new provenance, not a contradiction.

The hash is what makes reproducibility assertable rather than aspirational:
replay a session, compare hashes, and a kernel change that altered results
announces itself. The same mechanism gives kernel regression tests essentially
free — a stored script plus expected hashes is a test case.

### Sessions

A saved session is the command list plus source-image paths and their content
hashes. Loading replays it. If a source image has changed on disk, the hash
mismatch says so rather than silently producing different results.

### Determinism rules

Reproducibility across runs is not automatic in floating point. These are
rules, not suggestions:

**1. Reductions must have a fixed summation order.** Floating-point addition is
not associative, so a sum parallelised across the thread pool gives different
last bits depending on which thread finishes first — same machine, same input,
different answer. Use deterministic tiling: fixed tile boundaries, accumulate
per tile, combine tiles in fixed index order. Decide this before writing the
first reduction.

**2. Never enable `-ffast-math`.** It licenses the compiler to reorder float
operations. Reproducibility evaporates, including between debug and release.

**3. Compile with `-ffp-contract=off`, because cross-platform bit-exactness is
wanted.** `a*b + c` may fuse into a single FMA instruction with one rounding on
arm64 and compile to two roundings on x86-64. Without this flag, identical
source produces subtly different results on the development Mac and on a
Windows x86 machine — which is exactly the comparison this project invites,
given it ships on three platforms.

The cost is a small performance loss. Given that this is a learning lab where
results will be compared across machines, that is worth paying — and it is far
cheaper than diagnosing a mysterious cross-platform discrepancy later.

**This section said all of that, and `binding.gyp` did not set the flag** —
from the first kernel until the review that found it. `otool -tv` on the arm64
build of `kernels.o` counted **167** `fmadd`/`fmla` instructions: the Gaussian
taps, the Sobel weights and the TLS running sums were all being contracted,
and baseline x86-64 gets neither `-mfma` nor `-march=x86-64-v3` from node-gyp,
so it was not contracting any of them. Two platforms, two answers, for the
entire life of the project.

Two things about how it hid are worth keeping:

- **Nothing failed.** Every suite was green on all three runners the whole
  time, because no test compared a result on one platform against a result on
  another. Deciding a rule and writing it down is not the same as enforcing
  it — the same lesson as `gray` computing luma with `space: 'linear'`
  declared and checked nowhere.
- **The pixel buffers hid it and the geometry did not.** Rebuilding without
  the flag now moves only two hashes: `fit`'s and `corners`'. Buffers narrow
  to `f32` and the difference falls off the end; feature records hash
  full-precision doubles and keep it. So the divergence surfaced precisely
  where this lab claims *sub-pixel* accuracy, which is the worst place for it
  to be invisible.

`test/determinism.js` is what now holds the rule up, and it is the one suite
that is meaningless on a single machine: it asserts literal content hashes, so
what proves anything is three compilers on two instruction sets agreeing on
all of them. A failure there on one platform while the other two pass means
the build stopped being bit-reproducible — not that a kernel changed.

**3b. The flag was only half of it. `libm` was the other half.**

With `-ffp-contract=off` in place, the first matrix run produced **three**
different hashes for `fit` — and Linux and Windows disagreed with *each
other*, on the same instruction set with the same flags. No compiler flag
explains that.

IEEE 754 requires `+`, `-`, `*`, `/` and `sqrt` to be **correctly rounded**:
every conforming platform returns identical bits. It says nothing of the sort
about `atan2`, `sin`, `cos`, `exp`, `pow` or `hypot`. Those are
quality-of-implementation, and glibc, Apple's libm and MSVC's UCRT are three
different implementations. `-ffp-contract=off` cannot reach any of them.

The fix was to stop calling them where it matters. `cv_tls_line` — the
function every geometry stage depends on — recovered the principal axis with
`0.5·atan2(2·cxy, cxx − cyy)` and then `sin`/`cos`. A symmetric 2×2
eigenvector needs no trigonometry: with `d = cxx − cyy` and
`r = √(d² + 4·cxy²)`, the major axis is parallel to `(d + r, 2·cxy)`, which is
multiplication, addition and a square root. `fit`'s `angle` and `length` now
come from `cv_atan2` and `cv_len2` in `kernels.c`, built the same way. All
three agree with libm to 2–4 ULP, which was checked — but agreement with libm
is not the point, and would not be worth having if it cost determinism.

`fit`, `segments` and `merge` went to **v2**: the algorithms are unchanged and
the last bits are not.

**Why it hid in exactly one place.** Every buffer narrows to `f32` on the way
out, and `f32` has about eight orders of magnitude less resolution than a
`double` — so a last-bit difference in a double is absorbed and every pixel
hash matched on all three platforms. Feature records hash full-precision
doubles and absorb nothing. The divergence was invisible everywhere except in
the output where this lab claims *sub-pixel* accuracy.

**What is still not guaranteed, stated precisely:**

- `gaussian` calls `exp` and `toLinear`/`toSrgb` call `pow`; `orient` calls
  `atan2`. All three write `f32`, and all three currently agree across the
  matrix. That is margin, not a proof: a double sitting within one libm ULP of
  an `f32` rounding boundary would still split, with probability around 1e-9
  per value. On a 12 MP image that is roughly a 1% chance per run.
- `segments` and `merge` emit `i32` label maps, so a last-bit difference only
  shows up if it flips a threshold comparison. They agree today. A pixel
  sitting exactly at `maxResidual` would not, and then whole segments would
  differ rather than last bits.

Both are recorded rather than fixed, because both would mean replacing `exp`
and `pow` in the per-pixel path, and neither has been observed to bite. The
geometry was fixed because it *had* bitten, on the first run that looked.

**4. Where two routes reach the same value, make them agree on purpose.**
Found by a test, not by reasoning: `load(as=linear)` and
`toLinear(load(...))` differed by one `f32` ULP on about half the possible byte
values, because one route narrows an intermediate to `f32` and the other stays
in `double`. Numerically that is nothing. For a lab that compares content
hashes it is the difference between two provenance chains agreeing and not, so
the lookup table now narrows to `f32` before applying the transfer function,
deliberately. Expect more of these wherever a value can be computed two ways.

**What remains achievable:** bit-exact results within a machine, and — with
rules 3 and 3b — across platforms, for the geometry and for every buffer this
pipeline currently produces. What is not achievable is bit-exactness across
different compiler versions or optimisation levels; treat those as new
provenance, and record the addon build identity alongside operation versions.

*Still to do:* the session records the app version, the Electron version and
the platform, but **not the addon build identity** — so a hash that moved
because the compiler changed is currently indistinguishable from one that
moved because a kernel did. That is the one input to the rule above that a
saved session cannot yet report.

---

## 6. Views and display transforms

A tile is always the same kind of object, parameterised rather than
subclassed — there is no separate "histogram canvas" type:

```
tile = (slot, viewType, displayTransform)

viewType ∈ { image, histogram, lineProfile, surface, fft, stats }
```

Two tiles may show the same slot under different view types, and both update
when the slot changes.

Display transforms are **non-destructive** — they change how a buffer is drawn,
never what it contains:

| Aspect | Options |
|---|---|
| Range | auto min/max · fixed `[lo, hi]` · percentile (2–98%) · **symmetric about zero** |
| Curve | linear · log · abs · sqrt |
| Colormap | gray · viridis · turbo · diverging · categorical · **cyclic** |
| Channel | 0 · 1 · 2 · all |

Sensible defaults by data kind:

| Data | Default |
|---|---|
| Intensity, 0–1 | linear, gray |
| Signed (gradients) | **symmetric about zero, diverging colormap** — negatives one hue, positives the other, zero neutral |
| Label map (`i32`) | categorical colormap, nearest-neighbour, no interpolation |
| FFT magnitude | log scale |

The signed default matters: it is what makes a Sobel result immediately
readable instead of a grey smear.

---

## 7. Interaction

Two features fall directly out of uniform slots sharing a coordinate space, and
both are disproportionately useful for CV work. Design for them early — adding
them later is painful.

**Synchronised pan and zoom.** Comparing A against B nearly always means
looking at the same region in both. Cheap if all tiles share one viewport
transform.

**Multi-slot pixel probe.** Hovering anywhere shows `(x, y)` and the value in
*every* slot at once:

```
(1204, 883)   A: 0.784   B: 0.612   C: -0.204   D: 1
```

This is the single most useful debugging affordance in a tool of this kind, and
it exists only because the slots are uniform.

### Layout

A tile grid with a configurable column count. Each tile shows its slot name,
dimensions, dtype, and current display transform. A command bar and executed
log sit below; a slot inspector shows dtype, dimensions, min/max/mean and a
histogram thumbnail.

---

## 8. Where the data lives

From `electron-guide.md` §1: `contextBridge` deep-copies typed arrays, and the
measured cost of moving a 12 MP image across it is real. So:

- **Slot buffers live in C, owned by the preload context.** They are never sent
  to page script.
- **Views request a rendered RGBA tile at display resolution.** Roughly 1–2 MB
  crosses per tile regardless of the source image size.
- Full-resolution rendering happens only for the zoomed region actually
  visible.

Eight 12 MP `f32` slots is around 400 MB of buffer. That is fine as native
allocations and would not be fine as page-script typed arrays.

### JS cannot alias C memory — measured

The obvious implementation, handing JavaScript a typed array over the C
allocation, **does not work in Electron**:

```
napi_create_external_arraybuffer
  → napi_status 22: "External buffers are not allowed"
```

Plain Node allows it; Electron does not, because V8 is built with pointer
compression and a backing store must live inside V8's memory cage. Verified in
both runtimes at the point the buffer type was written, rather than discovered
later.

So the C layer owns 64-byte aligned memory and JavaScript reaches it through
**explicit copies** — `bufferRead` and `bufferWrite`, named so that no caller
assumes aliasing. A 48 MB round trip costs about 10 ms under Node and 13 ms
under Electron.

This costs nothing architecturally, because the plan above never wanted whole
buffers in page script anyway: views ask for a **downsampled tile at display
resolution**, which is 1–2 MB regardless of image size. `bufferRead` exists for
tests and debugging.

The rejected alternative was to let V8 allocate the memory with
`napi_create_arraybuffer` and have C write into it. That restores aliasing, but
ties every buffer's lifetime to a `napi_env`, prevents kernels allocating
temporaries outside a JS context, and gives up control of alignment — V8's
allocator makes no 64-byte guarantee, which the SIMD plan in §6 of the Electron
guide will want.

The architecture already validated in the skeleton — addon in the renderer
process, preload owning the pixels — is exactly what this needs.

---

## 9. Decide now vs. defer

Expensive to retrofit, so settle them first:

- `f32` working format and the 0–1 intensity convention
- deterministic reductions, `-ffp-contract=off`, no `-ffast-math`
- a cancellation flag in every kernel signature
- the operation registry as the single source of truth
- **resolving parameter defaults at record time**, and `(slot, version)` refs
  rather than bare slot names — both are what make an old log still mean what
  it meant
- an optional ROI rectangle in the operation signature, even if it is always
  "whole image" for now
- content hashing of buffers
- **a `space` field on every buffer**, and operations declaring which space
  they require — untracked color space produces results that are quietly wrong
  rather than obviously broken
- **treating kernel inputs as hostile from the first kernel**: sizes computed
  in `size_t`, dimensions checked before allocating, lengths never trusted

Safe to defer:

- undo/redo across slots
- a node-graph interface and automatic downstream recomputation
- a plugin system
- layer compositing
- ROI *editing* in the UI

---

## 10. A first slice

Small enough to finish, large enough to be genuinely useful:

- `f32` slots, auto-created on assignment, named `A`/`B`/… or user-named
- six operations: `load`, `gray`, `gaussian`, `sobel`, `threshold`, `stats`
  (plus `pattern` as a file-free source, and `toLinear` / `toSrgb`)
- command bar with an executed log, replayable
- two view types: image and histogram
- synchronised pan/zoom, and the multi-slot pixel probe
- a content hash per slot

That exercises the whole model — typed buffers, the registry, the command
path, provenance, and the display transforms — while leaving every deferred
item genuinely deferrable.

---

## 11. Open questions

- **Slot naming.** Auto `A`, `B`, `C` with optional renaming, or user-named
  from the start? Letters are quicker to type; names are self-documenting in a
  saved session.
- **Ground truth beyond a cube.** Twenty-four views settled which corner
  fields discriminate (§5) and every one of them was a synthetic cube in a lit
  room.

  *Settled:* the AOV passes are consumed now. `explain` samples across a
  detection in the depth, normal and albedo passes and reports what put it
  there — a depth step is an occlusion, a normal step without one is a crease,
  an albedo step is texture, and none of the three is shading. So an unmatched
  detection is no longer one bucket. Over six views of a cube on a table with a
  ball in a lit room, **111 of 123 invented segments were shading** — a shadow
  boundary or a specular terminator, which is a real image edge belonging to
  the light. The detector was right and the ground truth, which models geometry
  alone, was right to call it invented.

  *Settled, and sharper than the question asked:* §5's claim reproduces on a
  bare cube and fails on a furnished one. `scenes/cube-1.json` — one cube,
  nothing else — gives `endpointGap` an **18.8× margin with no overlap** over
  six views, and 13.8× on a single view, against §5's 14× from one hand-read
  image. The same pipeline on the cube-with-table-and-ball scene does not
  separate at all: the ranges overlap and the best F1 falls to 0.68. **The
  threshold survives the subject and fails on the clutter**, which is not what
  "does it hold on anything that is not a cube" was expecting.

  *Open, and newly visible:* corner precision on a multi-object scene is
  measuring the truth model as much as the detector. 37% of invented corners
  sat on real depth steps, and **half of those were formed by two segments that
  both matched real geometry** — two real occluding contours crossing in the
  image where no mesh vertex exists. A T-junction. Ground truth lists vertices,
  so it counts every one as invented. Whether it *should* carry image-space
  T-junctions is genuinely unclear: they are view-dependent, and an edge is
  not, so they are a property of the picture rather than of the scene.

  *Settled, and it contradicted the documentation:* the helmet's segments are
  now broken down. The 156-segment count reproduces — 164 an image over six
  views at 256 px — and **61% of the segments found match real geometry**. Four
  places in this repository claimed its edges were "overwhelmingly paint"; that
  was inferred from the model being a dense textured mesh and never measured.
  **Texture is 8%** of the invented segments. The dominant bucket is
  `occlusion` at 73%, sitting on depth steps of ~9 cm — indistinguishable from
  the steps under segments that *did* match — which is the T-junction problem
  again at twice the share. §5's threshold claim fails here as it failed on the
  clutter: nothing clean, best F1 0.51.

  *Open, and it is now the question:* whether those 73% are the matcher losing
  a fitted segment among dozens of tiny truth edges, or `explain` reading
  grazing slant as a step. It samples 2.5 px either side, and near the
  silhouette of a *curved* surface that distance buys a large depth change with
  no occlusion present — which a cube's flat faces cannot demonstrate, so no
  measurement so far could have caught it. Sweeping the sample offset would
  separate them: if the occlusion share tracks the offset, it is slant.

  *Open:* whether the thresholds hold on a photograph, where edges are noisier
  and geometry is not a box.

- **Ground-truth visibility is measured at the render size,** and nothing says
  so. The same scene from the same camera reports 3,045 of 9,572 edges visible
  at 256 px and 2,587 of the same 9,572 at 512 px: a coarser depth buffer
  occludes less of a dense mesh. The definition is defensible — visible in the
  image you actually rendered — but it makes **recall resolution-dependent**,
  in the direction that flatters the larger image, and the scoring table
  reports it as though it were a property of the detector. Either document it
  as a per-size figure or rasterise visibility at a fixed resolution
  independent of the render.

- **Multi-image operations.** Stereo pairs, image stacks and frame sequences
  all want more than "two inputs". Does a slot ever hold a *stack*, or is that
  N slots and an operation that takes a list?
- **Color policy.** *Settled:* every buffer carries a `space` field and
  operations declare what they need (§2). *Open:* which of the two policies —
  convert to `linear` on load and work there throughout, which is physically
  correct by default and costs nothing in `f32`; or keep values as loaded and
  convert only where an operation demands it, which keeps results comparable
  with other CV tools that operate on gamma-encoded values.
- **Higher-precision decoding.** *Settled:* `load` uses Chromium's decoder,
  borrowed from the renderer. Its kernel is injected rather than compiled,
  because that decoder only exists in a renderer — so `load` reports itself
  unimplemented under plain node instead of throwing when called. Only the
  decode is borrowed; the 8-bit-to-`f32` conversion happens in C, where sRGB to
  linear is an exact 256-entry lookup rather than a per-pixel power function.
  Two decode options are load-bearing: `colorSpaceConversion: 'none'`, because
  the default applies an embedded ICC profile and converts to the *display*
  profile, which would make the same file decode differently on a different
  monitor; and `premultiplyAlpha: 'none'`, which is lossy and would fold alpha
  into colour before it is dropped.

  *Open:* Chromium returns 8 bits per channel. 16-bit PNG, TIFF and camera raw
  still need a native decode path, and that means a third-party library and all
  the build complexity `electron-guide.md` §5 describes avoiding. Worth doing
  only when an experiment actually needs the precision.

  *Also settled:* what the stored bytes **mean** is now read from the file
  rather than assumed. `load` takes a `from` parameter alongside `as` — `from`
  says what the file holds, `as` says what the buffer should hold — and
  `scripts/png.js` reads PNG's `cICP`, `iCCP`, `sRGB` and `gAMA` chunks in
  specification precedence order to check it. Most files declare nothing, and
  the universal convention is sRGB, which stays the default. But a file
  declaring `gAMA 1.0` holds **linear** samples, and the lab refuses rather
  than applying a curve that was never there:

  ```
  load: the file declares linear samples (gAMA 100000 (gamma 1.0)),
        but from=srgb. Pass from=linear.
  ```

  An embedded ICC profile is read, not interpreted — saying "there is a
  profile" is honest; guessing at its transfer curve would not be. *Gap:*
  `readPngColour` returns `declared: 'icc'` and `load` then discards it, so
  nothing actually reaches the user. Only `srgb` and `linear` declarations
  cause a refusal today; a profiled file loads silently under the sRGB
  convention. Same bucket takes an uninterpretable `gAMA` — a file declaring
  gamma 0.5 is neither sRGB nor linear and is likewise waved through. PNG only:
  JPEG carries this in EXIF/ICC and WebP in its own chunks, and both fall back
  to the convention.
