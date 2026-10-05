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
#1  A ← load("samples/board.png")            sha256:9f2c…  4243×2829×3 f32 srgb    [v1]
#2  A ← toLinear(A#1)                        sha256:5db8…  4243×2829×3 f32 linear  [v2]
#3  B ← gray(A#2)                            sha256:7e10…  4243×2829×1 f32 linear  [v1]
#4  C ← gaussian(B#3, sigma=1.4)             sha256:31ab…  4243×2829×1 f32 linear  [v1]
#5  D ← sobel(C#4, axis=x)                   sha256:c740…  4243×2829×1 f32 —       [v1]
#6  E ← sobel(C#4, axis=y)                   sha256:0e55…  4243×2829×1 f32 —       [v1]
#7  F ← orient(D#5, E#6)                     sha256:aa13…  4243×2829×1 f32 —       [v1]
```

Reading that back:

- **A slot participates in many commands, but exactly one command *produced*
  each version of it.** `C#4` is produced by `#4` and consumed by `#5` and
  `#6`. "The command that produced it" is singular and correct; "the commands
  it took part in" is a different and larger set.
- **A slot's provenance is therefore a chain, not a line.** `F`'s provenance is
  the transitive closure `{#7, #6, #5, #4, #3, #2, #1}` — a DAG, since `C#4` is
  reached by two routes.

### Slots are versioned; log entries are immutable

`A = blur(A)` does not mutate the version it reads. It appends an entry
producing the next one — as `#2` above does, turning `A#1` into `A#2` — and
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

#### The curve stages

`chain` and `fitArcs` were added later and measured on a different machine, so
they get their own table rather than a column in the one above. `merge` is
repeated in it as the scale factor — this machine runs it about 2.5× faster,
so the two tables are comparable by ratio and not by absolute figure. Same
pipeline, `merge` output in, defaults throughout.

| image | merged → chained | `merge` | `chain` | `fitArcs` |
|---|---|---|---|---|
| 256² | 1,518 → 1,038 | 13 ms | 3 ms | 4 ms |
| 512² | 6,110 → 4,126 | 204 ms | 38 ms | 14 ms |
| 768² | 13,774 → 9,262 | 1,042 ms | 184 ms | 33 ms |
| 1024² | 24,510 → 16,446 | 3,301 ms | 565 ms | 64 ms |

`chain` is quadratic in segments and about 6× cheaper than `merge` at every
size — same candidate scan, but the turn window rejects most pairs before the
endpoint distance is computed, and far fewer survive to the pixel test.
`fitArcs` is linear in labels, like `fit`, and for the same reason: both call
`cv_label_index`.

**What a checkerboard says about `chain`, which is the useful part.** A
checkerboard has no curves, and `chain` still joined 480 pairs of the 1,518
labels at 256². That looks wrong and is not. Running `fit` either side of it:

| | labels | line residual, median | p90 | over 1 px |
|---|---|---|---|---|
| after `merge` | 1,518 | 0.294 | 0.733 | 0 |
| after `chain` | 1,038 | 0.555 | 0.733 | **15** |

465 of the 480 joins produce a label a straight line still describes within a
pixel — fragments of one block boundary that `merge` declined because no single
line held them, which a slightly bent one does. The 15 that a line no longer
describes are **exactly** the 15 `fitArcs` reports as arcs. So the two stages
agree about which joins were curves, and the disagreement rate on a subject
with no curves in it is 15 of 1,038.

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

#### A third, which every overlay drew and nobody saw

**The truth and the detections disagreed about where a pixel is.** The
detections are fitted through pixel *indices*, so pixel *i*'s centre is at
*x* = *i*. pt-lab projects the frame onto [0, size], so pixel *i* spans
[*i*, *i*+1] and its centre is at *i* + 0.5. Every detection was compared with
truth half a pixel down and right of it.

It was found on 2026-10-01 by splitting a gap measurement into its two edges.
Both edges came out displaced the same way by about half a pixel, which no
property of a single edge would do. Fitting one translation to every matched
segment of `cube1` gave (−0.507, −0.457). Removing it took the RMS offset of
those matches from 0.50 to 0.07 px.

It hid three ways:

- **`match` accepts anything within 3 px,** so no count moved enough to notice.
- **Every gap and every relative measurement cancels it,** to within 0.02 px.
- **The overlays drew it faithfully.** They put truth at *x*·scale, which is
  right for pt-lab's convention, and detections at the same, which is half a
  source pixel up and left. Every overlay ever made showed the detections
  slightly off their edges. It read as detector imprecision.

**The fix is at the one place truth enters the lab.** `parseGroundTruth` moves
every coordinate by −0.5 into the convention every kernel already used
(`groundTruth` v2). The `.gt.json` files keep pt-lab's. Both overlays now
draw lab coordinates at (*v* + 0.5)·scale. `explain`'s view rays had the same
half pixel in their optical centre, `w/2` instead of `(w − 1)/2` (`explain` v3).
That changed 1 cause in 983 on `helmet-256` and none elsewhere.

Re-measured over every existing result set. Detections were byte-identical
before and after; only the comparison moved:

| set | segment-hit distance, median | corner-hit distance, median |
|---|---|---|
| `cube1` | 0.527 → **0.062** px | 0.681 → 0.124 px |
| `cube` | 0.482 → 0.102 px | 0.725 → 0.224 px |
| `clutter` | 0.482 → 0.106 px | 0.722 → 0.179 px |
| `helmet-512` | 0.531 → 0.428 px | 1.584 → 1.594 px |

On the clean cube, the detector puts an edge to within about 0.06 px of the
geometry. A few counts move as edges that sat near the tolerance fall inside it:
segment misses on `cube` go from 84 to 79 and on `clutter` from 83 to 76. The
helmet barely changes, because its matches are loose against a dense mesh,
and that, not the convention, is its limit.

#### A fourth: the renderer's tone curve moved the edges

The question §11 used to ask, whether pt-lab writes gamma-encoded or linear
PNGs, has an answer, and it is **neither**. The beauty image is tone-mapped
with three.js's ACES Filmic curve and then sRGB-encoded. The lab undoes the
sRGB and nothing else, so what it calls linear is ACES-curved light.

That moves edges. The path tracer averages a pixel's samples in linear light
**before** the curve. A pixel half-covered by each of two surfaces holds the
midpoint of their radiances, but after an S-curve its value is not the
midpoint of their *displayed* values. So the 50% crossing that any
brightness-based detector finds slides off the geometry, toward whichever
side the curve favours.

It was found on 2026-10-01, after the pixel-convention fix, chasing the
gap sweep's remaining 20–50 mm bias.

- **Not the detector.** Measured straight across each edge in the render
  itself (luminance sampled perpendicular to the truth line, averaged along
  it, and the 50% crossing between the two plateaus found), the render's own
  step sat where the detector put it, to within ~0.05 px. The detector was
  faithfully finding a step that was in the wrong place.
- **Not blur.** The offsets did not move with σ from 0.7 to 2.0.
- **Not a scale or shift.** A fitted magnification error came out near
  zero once tone mapping was undone.
- **The curve.** With ACES inverted, the table's front edge moved from
  +0.20 px to within ±0.02 of its truth at every gap. The RMS step offset over
  clean edges fell from 0.080 to 0.030 px on `cube1` and from 0.111 to 0.061
  on `clutter`.

**The fix is in the generator, for measurement.** pt-lab gained
`setToneMapping('aces' | 'linear', exposure)`, and `npm run generate` gained
`--tone-mapping` and `--exposure`. Linear means radiance × exposure, clamped:
no curve. The default stays ACES at exposure 1, so every existing render stays
comparable. Each `.gt.json` now records the tone mapping it was made with.
`gap-sweep` defaults to linear at exposure 0.5, which keeps the gap scenes'
brightest measured surface (~1.2 in radiance) clear of clipping.

A fresh front-lit sweep rendered linear, against the ACES one (σ = 1.4; per-edge
offsets positive toward the cube):

| gap | ACES: error / cube / table | linear: error / cube / table |
|---|---|---|
| 50 mm | −0.34 / −0.17 / +0.16 | −0.28 / −0.29 / −0.00 |
| 20 mm | −0.38 / −0.23 / +0.15 | −0.22 / −0.21 / +0.01 |
| 10 mm | −0.17 / +0.01 / +0.18 | −0.03 / −0.04 / −0.00 |
| 5 mm | +0.01 / +0.21 / +0.20 | +0.10 / +0.12 / +0.01 |
| 2 mm | +1.21 / +1.08 / −0.12 | +1.18 / +1.14 / −0.04 |

**The table edge is fixed outright.** The gap bias at 20–50 mm is not: what is
left is the cube's edge, and it is a second effect, still open. The 50 mm
profile is a clean step with flat plateaus (0.171 | 0.360), centred 0.25 px
toward the table, with no shading ramp beside it. A second, independent linear
render repeated it to within 0.06 px, so it is a bias, not render noise.

It was first described as **"toward the darker side"**: the cube's edges with
a bright face inside moved +0.13 to +0.26 px outward, and those dark inside
moved −0.13 to +0.02 px. **That rule was tested, and it does not hold.** Each
scene below changes one thing from `gap-1-front`. The cube edge's offset is
positive toward the cube, and brightness is shown as gap side | cube face:

| scene (one change) | 50 mm | 20 mm |
|---|---|---|
| `gap-1-front`, red, glossy | −0.23 (0.17 \| 0.37) | −0.23 (0.08 \| 0.32) |
| `-low`: light 20 cm lower | −0.11 (0.14 \| 0.47) | −0.18 (0.06 \| 0.42) |
| `-dark`: cube #1a1a1a, still glossy | not found | **+0.20** (0.07 \| 0.14) |
| `-dark-matte`: same, shininess 0 | **−0.005** (0.17 \| 0.05) | too faint |
| `-matte`: red, shininess 0 | **−0.27** (0.17 \| 0.25) | −0.14 (0.08 \| 0.25) |

Lowering the light was meant to make the gap side the brighter one. It
darkened the gap instead, and the offset stayed. The dark glossy cube kept a
face brighter than the gap, because its gloss reflects the front light, yet
its offset **flipped sign**. The matte dark cube finally reversed the
contrast, with the gap side three times brighter than the face. The rule
predicts about +0.2 px there; the edge sat on its truth, at −0.005 px detected
and −0.021 in the render's own step.

What the runs support:

- **The offset belongs to the cube's appearance,** not to the lighting or the
  table. The table edge stayed within ±0.02 px through all four scenes.
- **Gloss is not the cause.** The matte red cube keeps the offset: −0.27 px
  at 50 mm, against −0.23 and −0.29 glossy. That fits `cube1`, whose cube is
  equally glossy and clean.
- **What the offset tracks is the face against the gap behind it.** With
  the face brighter (red glossy, red matte, lowered light), the edge sits
  0.1–0.3 px toward the gap. With the face darker (matte dark), it sits on
  its truth. The dark glossy cube, nearly equal to the gap (0.07 | 0.14 at
  20 mm), gave +0.20, which fits no simple rule.

**The line was closed here, with the cause unexplained, by decision.** What
remains is at most ~0.3 px (~0.25 mm at this scale), on one edge, at the
large gaps where accuracy matters least, in a synthetic image whose material
response a real camera will not share. The blur push-apart at 1–2 mm is five
to ten times larger, and is where assembly needs accuracy. The scenes stay in
`scenes/` (`gap-1-front-low`, `-dark`, `-dark-matte`, `-matte`) for whoever
reopens it.

A caution on method. Before the linear render existed, this was estimated by
inverting ACES on the existing renders, which suggested the cube edge would
fall to −0.08 px. It did not. Inverting ACES is unreliable on a saturated
red: its green and blue sit near the curve's clamp at zero, and what clamped
cannot be recovered. A direct render was the measurement; the inversion was
an estimate.

**Real cameras have the same problem,** a response curve applied after the
sensor integrates light over each pixel. Undoing a measured response on load,
with a `from=` that names a curve, is the general fix. It is not built.

#### A fifth: two edges close together displace each other

This one is the pipeline's, not the truth's or the renderer's. Every edge is
found in a blurred image, and for an edge on its own that costs nothing: a
symmetric blur leaves a step's gradient peak where the step is. Two steps a few
pixels apart are not on their own. Each one's gradient is displaced by the
other's tail, and the weaker step is displaced more.

In the gap sweep (linear renders, σ = 1.4), a true gap of 2.32 px read 3.50.
The Table's step is 0.60 → 0.12 and the Cube's 0.12 → 0.31, and 1.14 of the
1.18 px error was the Cube's edge. It is not fixed by choosing σ. Less blur
trades the displacement for noise: σ = 0.7 leaves +0.36 px at 2 mm, and at
1 mm (1.16 px) no σ finds both edges in the linear renders.

**The gap is in the pixels all the same.** Sampled unblurred, a 1.16 px gap is
two steps with a dip between them (`notes/brads-notes/2026-10-02.md`). So
detection keeps the job it is good at, saying that there are two edges and
roughly where, and `fitPairs` places them again, jointly, against the gray
image before `gaussian`. The model is three plateaus and two straight steps,
with each pixel holding the area-weighted mix of what it covers.

Gap error in px over two independent linear renders of the same sweep,
detections against the refit (`pipelines/pairs.lab`):

| gap (true px) | detected | refit | refit, Cube / Table edge |
|---|---|---|---|
| 5 mm (5.82) | +0.10, +0.10 | −0.07, −0.04 | −0.02 / +0.04, −0.04 / −0.00 |
| 2 mm (2.32) | +1.18, +1.22 | −0.11, −0.08 | −0.07 / +0.04, −0.05 / +0.03 |

**The refit does not depend on the blur that found the edges.** At 2 mm the
detections read +1.18, +0.55 and +0.36 px at σ = 1.4, 1.0 and 0.7. The refit
read −0.11, −0.09 and −0.10 from the same three sets of detections.

Two things were wrong before that table was right, and both are in
`src/lab/pairs.js` as decisions:

- **The aperture cannot be assumed.** How far a pixel gathers light from sets
  how soft every step looks. Held at 1 px (a pixel that averages exactly its
  own square), a true 1.16 px gap read +0.15 px; at 1.4 it read −0.26, each
  time with a claimed uncertainty of ±0.04.
- **It cannot be fitted per pair either.** One step seen through an aperture
  of 1 is, pixel for pixel, two steps half a pixel apart seen through an
  aperture of a half. Fitted that way, a single edge detected twice came back
  as a pair 0.50 px apart with an uncertainty of ±0.002.

The aperture belongs to the camera. So it is measured on the image's *lone*
segments, each fitted as a single step, and held for every pair. The median
is taken, and pt-lab's 512 px renders come out at 1.3 to 1.4.

**It was the lower quartile for a day, and that was wrong.** The argument was
that nothing in an image is sharper than the aperture allows and plenty is
softer (shadow edges read 5 px and more here), so the sharp end is the
camera. But things do read sharper than the truth. A segment with a dark strip
hidden against it fits a step 0.93 wide in an image drawn through 1.4. Measured
over the sixteen frames of the two linear sweeps, where the answer is a
constant, the quartile ranged 1.06 to 1.31 (sd 0.081) and the median 1.31 to
1.39 (sd 0.022). `fitPairs` is v2 for this.

**What it still does not do:**

- **It needs both edges detected.** At 1 mm and below the linear renders have
  no detection of the Cube's edge, so there is no pair to refit; that is the
  next subsection. Where a pair was detected at 1 mm (`gap-1-front-low`), the
  refit read −0.09 px.
- **Under about a pixel and a half the strip's level has to be supplied.**
  Seeded from ground truth over the two renders:

  | true gap | level fitted | level held at the 5 mm frames' 0.123 |
  |---|---|---|
  | 2.32 px | 2.22, 2.25 | 2.24, 2.23 |
  | 1.16 px | 0.92, 0.86 | 0.99, 1.02 |
  | 0.58 px | 1.02, 0.99 (± 0.15) | 0.37, 0.40 |

  At 1.16 px the fitted level comes out at 0.10 and 0.08, not 0.12, and the
  gap 0.1 px narrower for it. At 0.58 px the fit goes the other way, to a
  shallow strip twice the true width. This section said for a day that the fit
  finds the level itself at 1.16 px. That was read off the quartile aperture.
- **`gapSigma` is a scale, not a confidence interval.** It is the fit's
  curvature under its own residual, and neighbouring pixels' residuals are not
  independent. At 2 mm it is 0.015 and 0.027 px, the two renders differ by
  0.05, and both sit further from the truth than either.
- **It does not undo the renderer.** Over the ACES renders the refit at 2 mm
  is −0.28 px, and +0.28 of that is the Table's edge, where the tone curve
  put it.
- **A third edge inside the band breaks the model.** A shadow boundary in the
  gap is paired with the nearest edge and fitted as if nothing else were there.
- **A gap it cannot tell from none produces no record.** That is one edge
  found twice, or two parts in contact. It cannot say which.

#### A sixth: closer than a pixel and a half, there is only one detection

`fitPairs` places two edges the detector found. At 1 mm (1.16 px) the linear
renders give it nothing to place: the blur that finds edges has merged the two
into one. What is left is a single 512 px segment along the Table's edge, with
the strip under the Cube hidden in 114 px of it.

`findPairs` walks every segment that is in no pair, 24 px at a time, and asks
the unblurred pixels whether each window is one step or two. Runs of windows
that say two are joined and fitted once more as a whole. Along that table edge
at 1 mm, the two-step model's rms against the one-step model's, per window:

| where | gain |
|---|---|
| the 400 px with nothing under them, both renders | 1.00 to 1.05 |
| the windows under the Cube, render 1 | 1.35 to 1.63 |
| the windows under the Cube, render 2 | 2.08 to 2.57 |

So the strip is found, and where it is. Through `gap-sweep`, from the
detections alone (`pipelines/pairs.lab`, which runs both operations):

| gap (true px) | detected | refit, render 1 / 2 | from |
|---|---|---|---|
| 2 mm (2.32) | +1.18, +1.22 | −0.11 / −0.08 | `fitPairs` |
| 1 mm (1.16) | no pair | **−0.25 / −0.28** | `findPairs` |
| 1 mm, strip level held at 0.124 | no pair | −0.16 / −0.14 | `findPairs` |
| 0.5 mm (0.58) | no pair | nothing | |
| contact | no pair | nothing | |

The same at σ = 1.0 and 0.7: −0.25 / −0.28 and −0.24 / −0.28. `cube1`,
`clutter` and every other frame of both sweeps: no hidden pair reported where
none is, except one at 2 mm that is real (below).

**Finding it is the solid part; its width is not.** The 1 mm reading is
0.25 to 0.28 px short, all of it on the Cube's edge, and the two renders
agree. It is the fitted strip level again: 0.10 and 0.08 where it should be
0.12. Held, the reading is 0.14 to 0.16 short, which is where `fitPairs`
leaves 2 mm.

Three gates, and what each is for:

- **Gain of 1.3.** Two steps have three more parameters than one and always
  fit a little better. The number sits above everything an edge hiding nothing
  produced (1.05) and below the weakest window over a 1.16 px gap (1.35). That is five
  cases. It is a calibration, and the first image from a real camera may move
  it.
- **The strip must be darker than both neighbours, or brighter than both.** A
  level between them is what one soft edge looks like, and an edge softer than
  the aperture is common. This costs every real strip that lies between its
  neighbours' levels. With the level held, the caller has said what it is and
  the gate does not apply.
- **The second edge must be within `reach`, 2.4 px.** Unchecked, it left the
  pixels it was being looked for in and settled on other edges 4 to 15 px
  away.

And one thing it does not look at: **a segment nearly along the pixel grid.**
A sub-pixel strip is read off pixels that cross the edge at different places
across their width, and where a window climbs less than one pixel from end to
end they all cross at the same place. On the Cube's left edge, 0.9° off
vertical, one render of two reported a bright strip half a pixel wide at a
gain of 1.40. Such segments are skipped.

**What it does not do:**

- **0.5 mm.** The windows under the Cube gain 1.02 to 1.06, barely more than
  the same windows at contact (1.00 to 1.03) or the bare table edge beside
  them (up to 1.05). With the level held and the
  gain gate opened (`minGain=1`) it reads 0.36 and 0.33 px for 0.58, and
  nothing at the measuring point at contact. But opened that far it also
  reports 5 to 19 records an image along edges that hide nothing.
- **A misread, once.** `gap-1-front-low` at 0.5 mm: found, at a gain just
  over the gate, and read as 1.02 px for a true 0.58.
- **The ends of a strip.** A window half on the strip can pass or fail, so a
  run of three windows or more gives up half a window at each end. The stretch
  a record carries is where the strip was fitted, not where it stops.
- **Speed.** About a second an image at 512 px, against 0.06 for everything
  before it. Most windows are a no, and a second edge with nothing to find
  wanders until the iterations run out; capping those at 40 made it 2.5 times
  faster and changed no result on any frame of the sweep.

**The cheaper answer is more pixels.** Everything above is one regime: gaps
under about a pixel and a half. The same shots rendered at 2048 px, where 1 mm
is 4.6 px and 0.5 mm is 2.3, are ordinary detected pairs for `fitPairs`:

| gap | 512 px (1.16 px/mm) | 2048 px (4.65 px/mm) |
|---|---|---|
| 1 mm | −0.22 and −0.24 mm, found inside one segment | −0.011 mm |
| 0.5 mm | no reading | −0.017 mm |
| contact | no reading | no reading |

The 0.5 mm row at 2048 px is the 2 mm row at 512 over again, in pixels:
detected +1.19 px, refit −0.08. One render set, so no second sample.

**The strip keeps its level, so holding it is sound.** Read off the pixels in
its middle at 2048 px, with no model: 0.119, 0.122 and 0.116 at 5, 2 and 1 mm,
and 0.104 at 0.5 mm. That last 13% would move a 0.58 px reading by +0.06 px.

**But the strip is not flat.** Across its width it is about 0.136 for the 60%
nearest the Table's edge and falls to half that at the Cube's, where the table
top is deepest under it. The shape is the same fraction of the width at 20 mm
and at 1 mm, which is why the mean holds. The model fits one level to it. That
is the first suspect for the Cube's edge reading toward the gap, and it is
untested.

**It found one nobody was looking for.** At 2 mm, in one render (and at a gain
of 1.29 in the other, just under the gate): 16 px of the detection along the
Cube's right-hand bottom edge, with a strip 1.7 px wide inside it. It is the
same 2 mm gap, seen under the Cube's side face. The detected segment lay
0.4 px beyond the strip's far edge and 2.1 px from the Cube's.

#### A seventh: where the camera is decides how many pixels a millimetre is

Everything in the two subsections above was one view: 20° of yaw, 15° of
elevation, 0.45 m from the contact. `gap-sweep --yaw --elevation` repeats the
sweep from a grid of views, the saved camera orbited about its own target.
Four yaws by seven elevations by five gaps, 140 renders at 512 px, linear
(`gap-grid-1`).

**The truth-pair selection broke first.** It compared the two edges' mean
depths, and a metre of table edge seen at 45° has a mean depth nowhere near
that of a 10 cm cube resting on its near end. From yaw 45° and 70° there was
"no facing pair in the ground truth" at all. It compares depth where the gap
is measured now. A four-sample scan of the 28 views found that before any of
the hour of rendering was spent.

**Pixels per millimetre of gap**, from the truth alone:

| elevation \\ yaw | 0° | 20° | 45° | 70° |
|---|---|---|---|---|
| 0° | 1.22 | 1.22 | 1.23 | 1.23 |
| 15° | 1.17 | 1.16 | 1.13 | 0.93 |
| 30° | 1.04 | 1.02 | 0.92 | 0.60 |
| 45° | 0.84 | 0.81 | 0.68 | 0.38 |
| 60° | 0.59 | 0.56 | 0.45 | 0.23 |
| 75° | 0.30 | 0.29 | 0.22 | 0.11 |

The gap is vertical, so a camera sees less of it the more nearly it looks
down: the cosine of the elevation, and less again from the side.

**That table predicts the rest.** Whether a cell has a reading, and how good,
follows the gap's size in pixels and nothing else that was varied:

| true gap in the image | cells | read | refit error, px |
|---|---|---|---|
| under 1.1 px | 54 | 2 | one of them +1.15 |
| 1.1 to 2 px | 23 | 16, 11 of them inside one segment | −0.24 to −0.37 mean |
| 2 px and over | 35 | 31 | −0.20 mean, −0.52 to +0.06 |

The error in pixels does not depend on the view. It is the same −0.2 to
−0.3 px short everywhere something is read. So the error in millimetres is
that, divided by the table above: about −0.2 mm from the front and low, −0.6
at 45° up and 70° round, and −2.4 mm in the one cell read at 0.23 px per mm.

For gaps of 2 mm and over seen from 30° of elevation or lower, 29 of 32 cells
read, with a mean error of −0.22 mm (−1.04 to +0.05). The detections' own
reading over the same cells: +0.40 mm (−0.54 to +1.86).

**At contact, nothing is reported from any of the 28 views.** That is the
right answer, reached by not being able to see, and it is also what 0.5 mm
gets from 27 of them.

Three things the overlays showed that the table did not:

- **Square-on and level, at 0.5 mm, the one reading is of the wrong edge.**
  `match` accepts a detection within 3 px of a truth edge. There the cube's
  bottom edge is 0.6 px from the table's, and a shading line 2 px up the
  cube's face was taken for it.
- **At 0° of elevation the strip is not the table top.** The camera is level
  with it and sees through the gap. The fitted strip level is 0.03 to 0.11
  there against 0.13 from every higher view.
- **Square-on, the two edges lie along the pixel rows**, and `findPairs` does
  not search them. `fitPairs` does not mind: at yaw 0° it read 2 mm to
  −0.01 and −0.06 mm.

One scene and one render per cell. Nothing here has a second sample.

#### An eighth: two cubes, two pairs, and a crease the light erased

An edge pair measures one direction: across the edges. Sliding a part along
its edge changes nothing in the image. So the next fixture has two pairs at
right angles: `scenes/stack-1.json`, a cube on the table and a second the same
size (`Cube2`) lowered onto it, seen from a corner, 35° round and 20° up. The
analysis reports every facing pair now, one row each. Two edges are a pair
when each is the other's nearest facing edge.

The vertical approach, one view, one render per step. Refit error in px:

| gap | front pair (1.20 px/mm) | side pair (1.03 px/mm) |
|---|---|---|
| 5 mm | +0.003 | −0.59 |
| 2 mm | −0.03 | −0.13, found inside one segment |
| 1 mm | +0.09 | −0.16, found inside one segment |
| 0.5 mm | +0.28, found inside one segment | nothing |

**The front pair is the best reading this lab has made.** A few hundredths of
a pixel down to 1 mm, where the detections alone read +1.2 and +2.3 px. And it
says something about the gap sweep: the −0.2 px that was in every one of its
28 views is not in this one. So that bias was the table scene's, not the
fit's.

**The side pair is wrong by a shadow.** The base cube's side face and the
strip of its top face just inside the edge are lit to the same brightness,
0.137 against 0.139. The crease between them has no contrast at all. The
first step the image holds is where the top cube's shadow begins on the top
face, further in, and both the detector and the fit find that. The base
edge's offset, in px, at 20, 10, 5, 2 and 1 mm: 2.5, 1.4, 0.9, 0.4, 0.2. It
scales with the gap, because the lit sliver is as deep as the light can reach
under the top cube.

Nothing in the pipeline is wrong there, and nothing in it knows. `explain`
calls both of the pair's segments `crease`: it samples 2.5 px either side and
the crease is within that. The record's residual is small. Only the truth
says the edge is not where the image puts it.

That is the first measured case of something the grid could not show, because
its lights never moved: **which pair reads well depends on the light as much
as on the view.** A second view does not fix it. A second light might.

At 50 mm the side pair is not a pair: its two edges are 7.9° apart in the
image, from perspective alone, and the limit is 5°.

#### A ninth: three directions, from two pairs and two views

A gap is one number and a part's position is three. The stack's two pairs at
right angles were meant to supply the other two, and they do, with two
conditions that had to be found.

`gap-sweep --offset` slides the top cube across a gap that is already open.
Lifted 2 mm and slid ±5 mm, one view, pixels of gap per millimetre from the
truth:

| pair | sideways (x) | up (y) | toward the camera (z) |
|---|---|---|---|
| front | 0.00 | 1.20 | −0.50 |
| side | −0.81 | 1.04 | 0.00 |

Each pair is blind to a slide along its own edges, and each mixes the vertical
with one horizontal direction. Two readings, three unknowns: **one view of two
pairs does not determine a position.** A second view mixes them in other
proportions and does.

**First condition: the light.** Under `stack-1`'s light the side pair did not
track the slide it is the only one to see:

| sideways step, mm | −2 | −1 | −0.5 | 0 | +0.5 | +1 |
|---|---|---|---|---|---|---|
| true gap, px | 3.68 | 2.87 | 2.46 | 2.06 | 1.65 | 1.24 |
| read, `stack-1` | 1.73 | 1.77 | 1.70 | 1.90 | 1.91 | 1.47 |
| read, `stack-2` | 3.52 | 2.63 | 2.32 | 1.98 | 1.70 | 1.30 |

The gap opens by uncovering a ledge of the base cube's top face. Under the
first light that ledge is as bright as the side face below it, so the crease
that bounds it is invisible and the reading stays at the width of the shadow.
`stack-2` moves the one light low and between the two visible faces: both
bright, the top faces dark, every crease with contrast. The reading follows.
In and out, which the front pair sees, reads to within 0.11 px over ±2 mm
under either light.

**Second condition: the sign.** The true gap was signed toward the moving
*edge*, which makes it positive whichever side that edge is on. A part slid
until its edge passes the target's then reads as a gap closing to zero and
opening again, and a straight line fitted through that V has the wrong slope.
With the gaps signed toward the middle of the moving *part*, an edge that has
crossed is negative, and the linear model is exact: solved from the true gaps,
20 poses come back to 0.01 mm. Before the fix they came back to 0.1 to 0.5.

**Then, four views** (`stack-2`, yaw 35° and 60°, elevation 20° and 50°, the
top cube lifted 4 mm and moved ±4 mm along each axis, 80 renders). RMS error in
millimetres over the 20 poses, x / y / z:

| views combined | mm per px of reading error | detections | refit |
|---|---|---|---|
| any one | not determined | | |
| 35°/20° + 60°/50° | 1.07 / 0.97 / 0.93 | 1.72 / 0.80 / 1.98 | **0.11 / 0.08 / 0.08** |
| 35°/20° + 35°/50° | 0.93 / 1.00 / 1.16 | 1.81 / 0.82 / 1.90 | 0.09 / 0.12 / 0.13 |
| 35°/20° + 60°/20° | 2.79 / 1.66 / 2.45 | 1.32 / 0.40 / 1.15 | 0.19 / 0.12 / 0.16 |
| 35°/50° + 60°/50° | 1.59 / 3.22 / 1.43 | 2.17 / 2.38 / 2.20 | 0.13 / 0.20 / 0.11 (16 of 20) |
| all four | 0.73 / 0.69 / 0.68 | 1.88 / 0.85 / 1.84 | 0.11 / 0.14 / 0.10 |

- **A tenth of a millimetre on each axis from two views**, at 1.2 px per mm,
  where the detections' own gaps give one to two millimetres.
- **The second column is known before anything is rendered.** It is
  sqrt(diag((JᵀJ)⁻¹)), from the truth's Jacobian alone, and it says which
  views are worth combining: two at the same elevation leave three times the
  error of two at different ones, and two both looking down leave the
  vertical badly determined.
- **Four views are not better than the best two.** More readings lower the
  second column, but the views at 50° read gaps of 1.4 to 2.6 px, in the
  regime where readings are worse, and they bring that with them.
- **The worst pose is always the widest sideways one**, 4 mm: 0.2 to 0.6 mm
  off.

One render per pose, one scene, and the poses are all along an axis. A pose
off the axes has not been tried, and neither has a rotation.

A pose solved from readings that barely separate the axes comes back with
numbers anyway: one, having lost a reading, was put 1.3 m from where the part
was. Its own sigma said so, and `--max-sigma` is what refuses it.

#### A tenth: poses off the axes, and turned

Every pose of the ninth moved along one axis. The test of a solve is a pose it
was not built from. `gap-sweep --poses` renders a list of them, each a
displacement and a turn about the vertical; ten were chosen with all three
displacements non-zero, five of them turned ±1° to ±3°, from the same four
views.

**A turn is invisible at the middle of a pair.** It opens the gap at one end
and closes it at the other, and a reading at the middle moves by 0.03 to
0.11 px per degree, nearly nothing. So each pair is now read at its middle and
a sixth in from each end, and the Jacobian of the end readings has the turn in
it: −0.3 to −0.8 px per degree at one end, +0.3 to +0.8 at the other. With the
middles alone and the turn as a fourth unknown, every pose was refused: the
readings could not separate it.

RMS error on the ten test poses, x / y / z in mm and turn in degrees:

| views | from the truth | detections | refit |
|---|---|---|---|
| any one | not determined in x, y, z | | |
| 35°/20° + 60°/20° | 0.08 / 0.03 / 0.06 / 0.02 | 1.53 / 0.37 / 1.49 / 0.61 | **0.27 / 0.10 / 0.14 / 0.13** |
| 60°/20° + 60°/50° | 0.01 / 0.02 / 0.03 / 0.02 | 1.55 / 0.66 / 1.49 / 0.71 | 0.16 / 0.26 / 0.25 / 0.16 (9 of 10) |
| 35°/20° + 60°/50° | 0.01 / 0.02 / 0.03 / 0.01 | 1.44 / 0.70 / 1.71 / 0.74 | 0.18 / 0.33 / 0.61 / 0.18 (9 of 10) |
| three: 35°/20°, 60°/20°, 60°/50° | 0.01 / 0.01 / 0.03 / 0.02 | 1.81 / 0.58 / 1.64 / 0.65 | 0.13 / 0.20 / 0.24 / 0.14 |
| all four | 0.01 / 0.01 / 0.03 / 0.01 | 1.89 / 0.72 / 1.82 / 0.67 | 0.19 / 0.23 / 0.28 / 0.24 |

- **The linear model holds off the axes and through a 3° turn**: solved from
  the true readings, 0.01 to 0.08 mm.
- **Off-axis poses cost about twice what on-axis ones did**: 0.1 to 0.3 mm,
  against 0.1 to 0.15 on the sweeps' own poses with the same views. The worst
  pose is usually the one turned 3°.
- **The turn comes out to 0.1 to 0.25°**, where the detections give 0.6 to 0.7.
- **One view still does not determine a position.** With the end readings its
  six readings outnumber four unknowns, and it determines the turn to about a
  degree per pixel, but x, y and z come out at 500 to 2000 mm per pixel: the
  readings of one view hardly separate them.
- **More views are still not better than the right two.** The pair at the same
  elevation is best on the test poses, which it was not on the sweeps. With
  ten poses the order of the best few combinations is not settled.

#### An eleventh: a face's shading turned the edges, and weights only help once it does not

The refit's readings at the ends of a pair were worse than at its middle,
0.19 px RMS against 0.12, which a line fitted to noise would explain. Per
pair they were not noise. Every view of the stack's front pair read the gap
0.16 px wide at one end and 0.16 narrow at the other, the side pair the same
the other way round, and the middle true: the two fitted edges turned by
0.12° each, in opposite directions, scissors. The detections' own end
readings had no such tilt, so it came from the fit.

**The cause was the faces, not the strip.** Each face is brighter at one end
of the pair than the other, and the fit had one flat level per face. Where a
step is brighter than the model, the fit moves the edge to match; either side
of a strip, that moves the two edges apart at one end and together at the
other. Sloping the strip's level alone changed nothing. Giving every level a
slope along the pair (`fitPairs`'s `levelSlope`, on by default; v3) took the
end-to-end tilt error from 0.2–0.4 px to under 0.08 on every pair and view,
and the end readings to 0.12 px RMS, the same as the middle.

**Then the weights.** `gapSigma` hardly predicts a reading's error: over the
test poses its rank correlation with the absolute error is 0.34, and the worst
readings (the side pair at its widest gaps, 0.35 to 0.41 px short) have
ordinary sigmas. Weighting each reading by 1/gapSigma² still helps, because
within one pose it is lowest where the gap is wide and the edges long. Only
with the levels sloped does it help, though. With the ends still tilted, it
trusts those confident wrong readings and does nothing.

Mean RMS over the eleven sets of two or more views, x / y / z in mm and turn
in degrees:

| | sweep poses | test poses |
|---|---|---|
| as in the tenth | 0.18 / 0.18 / 0.14 / 0.18 | 0.30 / 0.31 / 0.34 / 0.25 |
| weighted only | 0.15 / 0.14 / 0.14 / 0.17 | 0.29 / 0.34 / 0.38 / 0.18 |
| levels sloped only | 0.18 / 0.18 / 0.13 / 0.12 | 0.29 / 0.30 / 0.32 / 0.19 |
| **both** | **0.09 / 0.10 / 0.08 / 0.06** | **0.18 / 0.25 / 0.30 / 0.05** |

The tenth's table, redone with both:

| views | refit, test poses |
|---|---|
| 35°/20° + 60°/20° | 0.34 / 0.16 / 0.23 / 0.07 |
| 60°/20° + 60°/50° | 0.17 / 0.33 / 0.31 / 0.04 (9 of 10) |
| 35°/20° + 60°/50° | 0.21 / 0.42 / 0.72 / 0.04 (9 of 10) |
| three: 35°/20°, 60°/20°, 60°/50° | 0.14 / 0.19 / 0.27 / 0.05 |
| all four | 0.13 / 0.20 / 0.27 / 0.04 |

- **The turn is settled**: 0.03 to 0.07° on every set of views.
- **Not every set got better.** The pair at one elevation, best before, is
  worse in all three directions, and 35°/20° + 60°/50° is worse in z. More
  views no longer cost anything: three and four are now among the best.
- **What is left is the side pair**, 0.13 to 0.18 px of scatter from pose to
  pose where the front pair has 0.02 to 0.04. It is the pair whose crease the
  light nearly erased (the eighth), and nothing in its record says which of
  its readings are the bad ones. (It is not scatter. It follows the pose, and
  its cause is in the fifteenth.)
- `findPairs` still fits flat levels. Its gain threshold was calibrated on
  them, and it has not been tried sloped.

#### A twelfth: what a wider frame knows, carried into a narrower one

Under about a pixel and a half the image alone does not determine a gap (the
sixth): width and strip level trade, the detector reports one segment or none,
and `findPairs` finds the strip in some views and not others. But a gap sweep
is an approach, and so is an assembly. Frames come in order, the gap closing,
and only one part moves. The other part's edge is the same line in every
frame. The strip's level and the aperture were measured while the gap was
wide.

**Carrying the level alone** (`strip=held`, from the last frame that read the
pair over 3 px) makes a reading better where there already was one: on the
gap grid at 1 mm, mean error −0.15 → −0.05 px, RMS 0.23 → 0.13, over the seven
views that read either way. It finds no new readings. Carried from a frame
only 2.4 px wide, the level was still traded against width (0.03 to 0.09,
against 0.10 to 0.14 from 6 px) and helped less.

**Carrying the still part's edge as well** changes what is asked. With the
line, the level and the aperture held, one edge is left to fit, the moving
part's, and nothing needs to have been detected: `trackPair` (pairs.js) fits
it beside the line, from four starting widths. `fitBand` takes `heldEdges`
for it.

| | 2 mm | 1 mm | 0.5 mm |
|---|---|---|---|
| gap grid, read without carrying | 17 of 28 | 8 | 1 |
| gap grid, tracked | 16 (−0.21 ± 0.10 px) | 16 (−0.19 ± 0.12) | 16 (−0.16 ± 0.07) |
| stack, read without carrying | 7 of 8 | 6 (−0.07 ± 0.18) | 2 (+0.19) |
| stack, tracked | 6 (−0.07 ± 0.06) | 6 (−0.04 ± 0.04) | 6 (+0.02 ± 0.02) |

The stack is `stack-2g-approach`, the top cube lowered onto the bottom one
from 5 mm, four views, two pairs each. Tracked gaps go down to 0.31 px on the
stack and 0.10 on the gap grid.

- **On the stack, tracking is unbiased**: 0.5 mm, 0.31 to 0.61 px in the image,
  reads to +0.02 ± 0.02 px. The gap grid's −0.2 px is the same −0.2 px it shows
  in every view at every gap without carrying (the seventh), so it belongs to
  that scene and not to tracking.
- **An error in the carried line is not an error in the gap, below a pixel.**
  Over a pixel it is, one for one. Under one, a strip of known level is as wide
  as its darkness says, and the moving edge follows the line instead: in a
  synthetic test a line carried 0.2 px off cost a 0.6 px gap 0.02. The fit's
  rms grows with the line's error either way, so a stale line can be noticed.
- **Contact is not refused everywhere.** Where the strip vanishes the fit's
  edges cross and nothing is returned. In 4 of 18 gap-grid views and 3 of the
  stack's 6 it returns 0.02 to 0.10 px instead, with a sigma that would pass a
  3-sigma test. On the stack every view still separates contact (0.05 to 0.10)
  from 0.5 mm (0.31 to 0.65), but a threshold that does it is set by the
  scene, so `trackPair` reports the gap and leaves contact to the caller.
- **A pair whose widest frame was under 3 px is not tracked**: two of the
  stack's eight. What to carry from a frame that never read wide is open.

This was measured as an experiment, the frames fitted again in plain node
(`notes/brads-notes/2026-10-04-carry/`) from a PNG decoder that is not the one
the lab loads with. It is now the lab's own: `trackPair` is an operation whose
carried values are **parameters**, and `gap-sweep --carry` writes them into
each narrower frame's command (through `lab-cli --extra`), so every carried
number is in that frame's log and the frame replays on its own. The command
language still has no variables (§4). The driver does the carrying, as the
batch runner already did the iterating. Run that way, the stack's eighteen
tracked readings agree with the experiment's to 0.002 px. They differ only
where the fit starts: the experiment started from the previous frame's gap,
the driver from the carried frame's. Contact, where the truth has no facing
pair, is reported as rows of tracks alone.

#### A thirteenth: the previous frame's pose, carried into the solve

The twelfth carried what a wider frame knew about a GAP. The same can be done
for the POSE. In an approach the robot moves the part by a commanded amount
between frames, so the last frame's solution, moved by that amount, is a
prior on this frame's. `solvePosition` takes one as a mean and a covariance
(position.js). Its information joins the readings', which must then be
weighted absolutely: a reading's error is taken as 0.1 px, scaled by its
gapSigma against the median. The covariance grows by the move's error each
frame. `npm run position -- --sequence <dir>` solves a sweep that way, frame
by frame, and also alone.

**The first measurement was wrong, and flattering.** It fed the solve the
TRUE commanded poses. A single view's two readings leave one direction
unseen, and there the solution simply kept the prior, which was the truth:
single views came out at 0.01 to 0.05 mm, and so did everything else. A robot
does not know where the part is, only where it told it to go. So the
commanded poses are the true ones with errors drawn at random: 1 mm on the
first pose, 0.1 mm on each move after it, over 20 seeded trials. A line for
the commanded moves alone, no camera, says what the camera has to beat:
0.7 / 1.1 / 0.9 mm (x / y / z).

Mean RMS over the eleven sets of two or more views, mm, x / y / z; "same" is
carried, on the frames a frame alone also solved:

| sequence | readings | alone | carried, same frames | carried, frames only it solved |
|---|---|---|---|---|
| approach to contact, 5 frames | refit | 0.17 / 0.16 / 0.16 (2.7 of 5 solved) | 0.11 / 0.06 / 0.06 | 0.14 / 0.13 / 0.16 |
| | tracked (`--carry`) | 0.09 / 0.05 / 0.04 (3.7 of 5) | 0.09 / 0.05 / 0.04 | 0.08 / 0.08 / 0.10 |
| x sweep, 7 frames | refit | 0.19 / 0.21 / 0.17 | 0.19 / 0.24 / 0.19 | 0.15 / 0.17 / 0.08 |
| y sweep, 6 frames | refit | 0.11 / 0.06 / 0.04 | 0.12 / 0.06 / 0.05 | (all solved alone) |

- **Carrying the pose solves the frames that lose their readings**: contact,
  and the 0.5 mm frame where the refit has nothing, to about 0.1 mm.
- **It does not improve frames that read well**, and can cost a few
  hundredths. Their errors are biases that repeat from frame to frame (the
  side pair's, mostly), and fusing frames does not average a bias.
- **With the noisy refit readings at narrow gaps it halves the error**. Tracking
  the gaps (the twelfth) had already done that, from the other end.
- **One view stays one view.** Carried, a single view's error is 0.4 to 0.5 mm,
  half of dead reckoning's, and that is all. The direction its readings cannot
  see is the same in every frame, so it never improves on the starting error.
  A camera that moves between frames would change that; one that stays put
  cannot.
- **It depends on the robot.** At 0.02 mm a move, the frames only carrying
  solves come out at 0.05 mm, and the x sweep is a little worse (each frame's
  bias carried into the next); at 0.5 mm a move, they come out at 0.5.

#### A fourteenth: calibrating from what was read, and a light that moved the problem

Every reference and Jacobian so far came from the renderer's truth, which a
real cell does not have, and which leaves a reading's steady bias in every
solve. `npm run position -- --calibrate reference` takes each reading's
reference from what was read at the reference pose instead: every sweep's
step 0, three renders of one pose, averaged. `--calibrate full` takes the
Jacobian from the readings' slopes too, and uses no truth at all. Each kind
of reading is calibrated against itself.

The question came from the light. Under `scenes/stack-3.json`, the light swung
toward the side face, the side pair's scatter on the x sweep halved and it read
a steady 0.2 px short instead (`notes/brads-notes/2026-10-05.md`); a steady
bias is what calibration removes. The high light of `stack-4.json` erased the
base cube's front crease and was not pursued.

Mean RMS on the ten test poses over the eleven sets of two or more views,
x / y / z mm and turn degrees:

| light | readings | truth | reference | full |
|---|---|---|---|---|
| stack-2 | detected | 1.67 / 0.82 / 1.75 / 0.72 | 0.98 / 0.35 / 0.93 / 0.73 | 0.73 / 0.29 / 0.58 / 0.44 |
| stack-2 | refit | 0.18 / 0.25 / 0.30 / 0.05 | 0.23 / 0.22 / 0.27 / 0.05 | 0.25 / 0.21 / 0.23 / 0.14 |
| stack-3 (side) | refit | 0.17 / 0.29 / 0.36 / 0.06 | 0.33 / 0.40 / 0.48 / 0.14 | 1.45 / 0.84 / 5.38 / 0.09 |

- **Calibration removes a steady bias.** The detections' error is mostly the
  blur's push-apart, steady for a given gap, and calibrating more than halves
  it, with no truth at all.
- **The refit's remaining error is scatter, and calibration cannot touch it.**
  Under stack-2's light it stays at about 0.2 mm however it is calibrated.
  With no truth at all it is 0.25 / 0.21 / 0.23 mm and 0.14 degrees: the turn
  suffers, because slopes measured off end readings are noisier than the
  truth's.
- **The side light moved the problem.** Under it the side pair is steady in
  every run, within-view scatter 0.02 to 0.07 px, as hoped; but the front pair,
  0.03 px under stack-2's light, scatters 0.07 to 0.14 and loses its reading
  in a third of the frames. Calibrated, it is worse than not: the reference is
  read off three frames, and the front pair's scatter in those three is put
  into every solve. Fitted through the same scatter, `full`'s slopes give a
  Jacobian that barely separates the axes.
- So no light tried keeps both strips dark and steady, and stack-2's is still
  the best. Calibrating from more frames than three would make the reference
  less noisy; it cannot make scattered readings steady.

#### A fifteenth: the side pair's error is a ledge in soft shadow

The side pair's error was called scatter from the eleventh on: 0.13 to
0.18 px from pose to pose, unpredicted by its record, untouched by
calibration (the fourteenth). Sorted by the pose instead of pooled, it is
not scatter at all. On the x sweep it is the base cube's edge, not the moving
one, that is misplaced, and only on one side:

| top cube slid along x | base cube's edge read into the gap | gap error |
|---|---|---|
| −2, −1 mm | 0.35 to 0.49 px (20° views) | −0.31 to −0.41 px |
| 0 mm | 0.09 to 0.13 px | −0.09 to −0.13 px |
| +1 to +4 mm | within 0.04 px | within 0.06 px |

On the ten test poses the same: every pose slid toward −x reads that edge 0.1
to 0.5 px into the gap, every pose slid +0.5 mm or more within 0.03.

**The brightness across the gap says why.** Averaged along the pair, binned
by distance from the true base edge (`notes/brads-notes/2026-10-05-profile/`):
slid +2 mm, the profile is a clean step at the edge, and the fit's own model
matches it to 0.003 everywhere. Slid −2 mm, it falls from the face's 0.31 to
the strip's 0.07 over about 2 px instead (0.27, 0.21, 0.17, 0.13, 0.09),
where the aperture alone would soften it over 0.7. The model has one sharp
edge and a flat strip, and it puts the edge in the middle of the ramp, half a
pixel into the gap.

**The ramp is geometry and light.** Slid back, the top cube's side face sits
behind the base cube's, and a ledge of the base cube's top face shows inside
the gap. The scene's light is an area light, so the top cube's shadow across
that ledge has a penumbra. Slid the other way, the top cube overhangs, the
ledge is hidden, and the gap is one dark strip. The front pair shows the
same, smaller (0.04 to 0.10 px), when the top cube is slid back in z.

- It is a real-world effect and not a renderer's: any ledge under a light
  of any size does it.
- It explains why the side light helped one pair and hurt the other (the
  fourteenth): moving the light moves the penumbras.
- What would describe it: a third, soft edge inside the strip -- a shadow
  boundary with its own position and its own width -- so a ledge can be a
  level of its own. Over a gap a few pixels wide that is identifiable; under
  a pixel and a half it is not, and there is no ledge to see either.

**That was tried, and it detects a ledge without placing one.** `fitBand`
was given soft edges, free or anchored to start their ramp at another edge
(pairs.js; the scripts that measured this are in
`notes/brads-notes/2026-10-05-shadow-edge/`). On the x sweep's pair 2:

| | ledge frames (slid −1, −2 mm) | clean frames |
|---|---|---|
| as fitted | −0.31 to −0.41 px | within 0.06 |
| with a soft edge, anchored | −0.26 to +0.29 (the base edge pushed out) | unchanged |
| the base edge held where a clean frame read it | +0.09 to +0.15 | within 0.03 |
| held, and the soft edge | −0.17 to +0.41, erratic | can run away (0.85) |

- **As a detector the soft edge is reliable**: it fits ledge frames 1.4 to
  2.5 times better than two edges do, clean frames 1.0 to 1.1.
- **As a measurement it is not.** Blurred to the pixel, a ramp starting at an
  edge and an edge a little further out with a ramp beyond it are nearly the
  same picture; the pixels do not pin the edge under a penumbra to better than
  about 0.2 px.
- **What works is not measuring that edge there at all.** The base cube does
  not move, so its edge is one line in every frame of a view; read where no
  ledge hides it and held, it takes the ledge frames' error from 0.31–0.41 to
  0.09–0.15 px and leaves clean frames as they were. That is the twelfth's
  carrying, applied to every frame rather than the narrow ones: detect the
  ledge with the soft edge, take the still edge from a frame without one.

#### A sixteenth: the still edge held, everywhere

The fifteenth ended with a plan: let a soft edge DETECT a ledge, and take the
still part's edge from a frame without one. Built:

- **`fitPairs` asks whether there is a ledge** (v4, `ledge: 'detect'`). Over a
  gap of 2 px and more it fits the pixels again with a ramp anchored at each
  edge in turn, and records `ledge.gain` and `ledge.edge`. It does not move
  the edges.
- **`gap-sweep --carry` holds the still edge in every frame of a view.** The
  source is no longer the widest frame of an approach but, of the frames that
  read the pair as two detected edges over 3 px with no ledge in them (gain
  under 1.2), the one whose still edge is the median of theirs. The widest
  was tried first and failed: on the x sweep the widest frame under 1.2 still
  had a mild ledge, read its still edge 0.09 to 0.13 px off, and every frame
  inherited it -- the clean frames got worse, 0.12 to 0.27 px. The median
  outvotes it. Every frame then reads the pair with `trackPair`, the strip
  fitted where the frame is wide enough to show it and held where not, which
  makes the twelfth's approach a special case. It now runs on sweeps across
  an open gap and on lists of poses too.
- **`trackPair` tells a strip from one edge.** Holding the still line in
  every frame met a case the approach never had: at 50 degrees, low and slid,
  the moving edge passes in front of the still one, and the true gap is
  negative. Two edges forced onto that read +0.2 px; one overhang of 1.19 px
  read +0.18. The same pixels are fitted as one edge beside the line, and as
  two edges neither held: a strip when the held two fit 1.2 times better than
  one or the free two 1.15 times; one edge when the held two fit no better
  than one and the free fit finds no strip; otherwise no reading. The free
  fit is there because a carried line 0.2 px off makes the held fit worse
  and, without it, handed a real 0.6 px strip to the single edge. The single
  edge read overhangs of −0.43, −0.82 and −1.19 px as −0.52, −0.87 and −1.27.
  Asking for the one edge on no evidence -- when the held fit merely failed --
  read real 1.2 to 2.7 px gaps as −0.4; it needs a ratio under 1 now.

On the stack under stack-2's light, refit against tracked on the rows both
read, RMS px:

| | pair 1 | pair 2, clean | pair 2, ledge |
|---|---|---|---|
| x sweep | 0.018 → 0.020 | 0.117 → 0.093 | 0.351 → **0.033** |
| test poses | 0.038 → 0.029 | 0.120 → 0.073 | 0.216 → 0.138 |
| turns | 0.026 → 0.032 | 0.117 → 0.115 | 0.144 → 0.077 |
| y sweep | 0.031 → 0.032 | 0.108 → 0.124 | (none) |

And the position, on the ten test poses, mean over the eleven sets of two or
more views, x / y / z mm and turn degrees:

| readings | from the truth | no truth at all |
|---|---|---|
| detections | 1.67 / 0.82 / 1.75 / 0.72 | 0.73 / 0.29 / 0.58 / 0.44 |
| refit | 0.18 / 0.25 / 0.30 / 0.05 | 0.25 / 0.21 / 0.23 / 0.14 |
| **still edge held** | **0.11 / 0.06 / 0.07 / 0.04** | 0.23 / 0.17 / 0.15 / 0.11 |

All four views together: 0.08 / 0.02 / 0.05 mm and 0.03 degrees.

- **The ledge was the largest error left**, and holding the still edge is
  what removes it. The ledge detector's job is only to keep ledge frames out
  of the source.
- **With no truth at all the gain is smaller.** The Jacobian measured from
  the readings' own slopes is the noisier part now, not the readings.
- **The 50-degree views often have nothing to carry from**: few of their
  frames read a pair 3 px wide. They fall back to the refit.
- **The y sweep's side pair got slightly worse** (0.108 → 0.124 px), the one
  place it did; not chased.

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
- **`explain` calls `acos` and `tan`, and has no `f32` to hide behind.**
  `angleBetween` has called `acos` since v1 for `normalStep`; v2 adds another
  for `slant`, and `tan` once per image for the focal length. These write
  **feature records**, which are doubles hashed as they are — so where a buffer
  rounds a last-bit difference away before it can reach a hash, this does not,
  and a single differing ULP changes the content hash of the whole list. The
  matrix agrees today, which is why it is written down rather than fixed.

  The precedent is against it. `fit` v2 exists precisely because the geometry
  path's `atan2` and `hypot` had to stop being libm's: `cv_atan2` and `cv_len2`
  (`native/kernels.h`) are the project's own, and replacing them is what made a
  feature list compare equal across platforms at all. `explain` reached for
  `Math.acos` in pure JS and reintroduced the same exposure by a different
  door — a `cv_acos`-shaped answer exists, and the JS path has no route to it
  today.
- `segments`, `merge` and `chain` emit `i32` label maps, so a last-bit
  difference only shows up if it flips a threshold comparison. They agree
  today. A pixel sitting exactly at `maxResidual` would not, and then whole
  segments would differ rather than last bits.

**The curve stages were built to this rule rather than corrected into it.**
`cv_circle_solve` is Kåsa's algebraic fit: centred moments, one 2×2 solve and
one square root, so it is `+ − × ÷ sqrt` throughout and correctly rounded
everywhere by IEEE 754. That is also the argument against the primitive the
*subject* deserves — a nut's curves are circles seen obliquely, so an ellipse
describes them and a circle does not, but a conic needs an eigenvector of a
3×3 and the textbook route to one is `acos` and `cbrt`. Putting those in the
function every curve stage depends on is the failure above, repeated
knowingly. Measurement said the trade costs little: over the 26–50° of sweep a
chain candidate spans, a conic beat the circle on 6 of 12 chains by a median
of **0.001 px** and returned a hyperbola on 4 of them, because its extra
parameters are not identifiable over that short an arc (2026-09-20).

`test/determinism.js` pins both of them, on a fixture built by the midpoint
circle algorithm — integers and comparisons, no trigonometry — because a
fixture that itself differed across the matrix would make the test report a
divergence it had caused. `pattern` cannot draw a curve, and the blurred
impulse that comes closest hangs the whole pipeline off a `minMag` near 1e-4,
which measures the blur's tail rather than the geometry.

`fitArcs` has the same exposure `fit` had and avoids it the same way. An arc's
endpoints are the two extreme pixels projected radially onto the fitted circle
— `c + r·(p − c)/|p − c|` — rather than the circle evaluated at the endpoint
angle, which would be `sin` and `cos`. Both reach the same point, since the
projection lies on the ray the angle names; only one of them is reproducible.
`angle0` and `angle1` come from `cv_atan2`.

All three are recorded rather than fixed, because the first two would mean
replacing `exp` and `pow` in the per-pixel path and none has been observed to
bite. The geometry was fixed because it *had* bitten, on the first run that
looked.

**4. Where two routes reach the same value, make them agree on purpose.**
Found by a test, not by reasoning: `load(as=linear)` and
`toLinear(load(...))` differed by one `f32` ULP on about half the possible byte
values, because one route narrows an intermediate to `f32` and the other stays
in `double`. Numerically that is nothing. For a lab that compares content
hashes it is the difference between two provenance chains agreeing and not, so
the lookup table now narrows to `f32` before applying the transfer function,
deliberately. Expect more of these wherever a value can be computed two ways.

**5. Anything that assigns identities must number them canonically.** A label
is not a measurement — it is a name — and the name must be a function of the
image, not of the order in which the algorithm happened to find things.
`segments` grows regions in order of gradient magnitude, and that ordering is
not guaranteed identical across platforms in its last bits: two runs finding
*the same* regions but numbering them differently produce different content
hashes, and a replay then reports a change that did not happen. So both
`segments` and `merge` renumber at the end, by **raster order of each label's
first pixel** — `native/kernels.c:1121` and `:1358`. `merge` matters for the
second reason as well: its numbering would otherwise depend on the order the
unions occurred in.

The rule generalises past label maps. Any operation that emits ids — feature
records included — owes them an ordering derived from the data, because a hash
over a set of identities is only stable if the identities are.

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
| Colormap | gray · viridis · turbo · diverging · categorical · **cyclic** · mask |
| Channel | 0 · 1 · 2 · all |

Sensible defaults by data kind:

| Data | Default |
|---|---|
| Intensity, 0–1 | linear, gray |
| Signed (gradients) | **symmetric about zero, diverging colormap** — negatives one hue, positives the other, zero neutral |
| Label map (`i32`) | **mask** colormap, nearest-neighbour, no interpolation. Written here as `categorical` and changed once there were overlays: twelve hues under a red-and-green overlay answer "which segment is this" while the reader is asking "where are the segments". `categorical` is one dropdown away |
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
  measuring the truth model as much as the detector. Under `explain` v1, 37% of
  invented corners sat on real depth steps, and **half of those were formed by
  two segments that both matched real geometry** — two real occluding contours
  crossing in the image where no mesh vertex exists. A T-junction. Ground truth
  lists vertices, so it counts every one as invented. Whether it *should* carry
  image-space T-junctions is genuinely unclear: they are view-dependent, and an
  edge is not, so they are a property of the picture rather than of the scene.

  *Re-measured under v2, 09-12:* **24%**, of 311 invented corners — the rest
  being 74% shading, 2% crease. The v1 figure was inflated by the depth defect
  described below, as every other number in that column was.

  The T-junction reading survives the correction and gets **stronger**. Of the
  74 invented corners still on a depth step, **60 (81%) are formed by two or
  more segments that themselves matched real geometry**, and 47 of them by
  segments that *all* matched — against "half of those" under v1. So what is
  left after the slant defect is removed is disproportionately the case ground
  truth cannot represent: real contours crossing where the model has no vertex.
  It is now the dominant explanation for an invented corner on a depth step,
  not a third of one.

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

  *Settled, and it invalidates the measurement rather than the detector:* it is
  slant. Sweeping `explain`'s `offset` over 1.0 / 1.5 / 2.5 / 4 / 6 / 8 px, the
  invented-occlusion share on the helmet runs **57% → 92%** and on the clutter
  scene **0% → 19%**, with detections, matches and misses identical in every
  row. Matched detections drift with it too — 65% → 99% — so the classifier is
  offset-dependent on everything it touches, not only on what failed to match.

  The per-detection test is decisive. A real step is the size of the step and
  does not care how far either side it is sampled; a slant is a gradient and
  scales with the sampling distance. Each detection's `depthStep` at offset 8
  over its value at 1.0 — an 8× change in distance — comes back at a median of
  **8.03** over the helmet's 282 invented occlusions, and **1.12** over the
  clutter scene's 61 matched ones, which are real silhouettes against a
  background. Constant gradient against genuine step, measured on the same
  data. **241 of the 282 are grazing surface; 13 survive as real depth steps.**

  Two consequences. The T-junction question above is 13 segments on the helmet
  rather than 282, and the clutter scene's 37% became 24% when the same test
  was run on it (09-12). And **every AOV breakdown on record inherits the
  defect**, the matched column included — v1's depth test compared a fixed 2 cm
  threshold against a difference read at a fixed pixel distance, and what a
  benign slant produces scales with the offset, the resolution and the camera
  distance. No constant is right. The test would have to subtract the step that
  slant alone accounts for, from the normal pass and the view direction, and
  fire only on the excess. Not attempted: changing it changes every number this
  repository has published from it.

  *Settled, and it names the fix:* the normal pass was then read at the same
  sample points, asking whether **one tangent plane through the midpoint
  accounts for the depth difference `explain` measured**. Predicted over
  measured is **0.99** (p25–p75 0.93–1.00) across the 241, and **0.07**
  (0.02–0.18) across the 199 matched detections whose step is offset-invariant.
  A continuous surface gives 1; a real discontinuity cannot be reached by a
  plane fitted on one side of it. The mechanism is measured, not inferred.

  Two things fell out. The **normal pass is in view space**, which nothing
  here said — established by the fit (a world→camera rotation gives 1.16,
  spread 0.72–1.28) and corroborated by the normal at one pixel staying
  +Z-dominant across three cameras 6 m apart. And **slant does not
  discriminate**: median slant is 64.0° under the slant group and 64.1° under
  the genuine steps, because both live at a silhouette, where a surface turns
  away *and* where one surface ends in front of another. A threshold on slant
  would be no better than the threshold on depth it replaced.

  What discriminates is the residual, and `explain` **v2** now tests it: each
  side's tangent plane is extended to the other side and asked whether the
  depth recorded there is where a continuous surface would have put it. The
  camera's field of view is taken from the `.gt.json` beside the `maxDepth`
  already read from there, and only the fov is needed, the normals being in
  view space. `depthStep`, `planeStep`, `depthExcess` and `slant` are all
  recorded, so a record says which it was, and the operation refuses without a
  fov rather than producing v1's answer under v2's number.

  On the same six views: invented `occlusion` falls **282 → 88**, and **all
  199** detections whose step was verified offset-invariant keep it. The
  displaced ones land in `shading` (46 → 218) and `texture` (32 → 52), which is
  where a real image edge on a smoothly receding surface belongs.

  Two things the implementation had to be told by a test rather than by
  reasoning. The plane must be anchored on the samples, never on the midpoint
  between them — at a real edge the midpoint is the one place neither surface
  is, and since the prediction scales with the depth there, a 0.4 m step
  accounted for a fifth of itself. And it is the **larger** of the two
  prediction errors that matters: a plane anchored on the far side of a step is
  anchored deeper, slant costs depth in proportion to depth, and that side
  over-explains the step it is standing on.

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

- **Arcs are scored.** *Settled, and the reasoning that deferred it was
  wrong.* This entry used to say `match` could not take an arc, because
  `gt-edge` records are straight chords off a tessellated mesh, so a fitted
  arc crosses a fan of them and "matches" only the modal one — reading as one
  hit in twelve on a perfect detection. The conclusion drawn was that an arc
  needed a coverage set and `score.js` a coverage tally.

  None of that was needed, because `match` already does not have the defect.
  It runs **two passes asking two different questions**, and recall walks the
  TRUTH: each of the twelve chords is asked separately whether anything covers
  it, so one arc along all twelve is credited with finding all twelve. That is
  the same defect, and the same fix, the ball's silhouette forced on segments
  long before arcs existed — written down four lines above the code, and not
  read. The whole change was geometry: sample along the curve, measure
  distance to the curve, and compare a truth edge against the arc's **tangent**
  where that edge is rather than one angle for the whole arc.

  *Open, and separate:* recall is per list. `fit` and `fitArcs` describe one
  label map, so an edge covered by a segment counts as missed by the arcs and
  the other way round, and no operation builds one list from both. Precision
  is the number that means what it says. On the nut at 512: segments 50%,
  arcs **59%** — the curved description is right more often than the straight
  one on a subject made of curves.

  *Also open, and untouched by any of this:* the silhouette of a smooth
  surface is where **n·v = 0** — not a mesh feature, not on mesh edges, and
  moving with the camera. On a curved subject that is the majority case rather
  than an artefact. Emitting analytic `gt-arc` records would fix a chord
  problem that turned out not to exist, and not this one.

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
