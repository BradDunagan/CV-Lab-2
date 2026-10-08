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
sensor integrates light over each pixel. Undoing a measured response on load
is the general fix, and it is built: `npm run response` measures the curve
from an exposure bracket and `load(curve=)` undoes it. (A gamma left in costs
nothing, a contrast curve whose shoulder the lit faces reach four to nine
times the error, and the curve undone none, so long as nothing clips at 255:
"A thirty-sixth", "A thirty-seventh".)

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

#### A seventeenth: calibrating with no truth, jointly

With the still edge held (the sixteenth), calibrating from the readings
alone gave the test poses 0.23 / 0.17 / 0.15 mm and 0.11 degrees, against
0.11 / 0.06 / 0.07 and 0.04 from the truth. Split: references measured and
slopes from the truth cost x alone (0.11 → 0.18); measuring the slopes too
cost y, z and the turn. `--calibrate full` fitted each slope as a line down
one sweep, five to seven frames, each sweep with its own intercept.

`--calibrate joint` fits each reading's reference and all four slopes in one
least-squares fit over every frame of every sweep -- 17 to 25 frames a
reading -- drops frames more than 3 MADs off and fits again. Test poses, mean
over the eleven multi-view sets, x / y / z mm and turn degrees, no truth
anywhere:

| readings | full | joint |
|---|---|---|
| detections | 0.73 / 0.29 / 0.58 / 0.44 | 0.71 / 0.32 / 0.64 / 0.43 |
| refit | 0.25 / 0.21 / 0.23 / 0.14 | 0.18 / 0.16 / 0.19 / 0.08 |
| still edge held | 0.23 / 0.17 / 0.15 / 0.11 | **0.19 / 0.09 / 0.10 / 0.06** |

All four views, held, no truth: 0.18 / 0.05 / 0.08 mm and 0.06 degrees.

- **Every slope the joint fit measures is within a few hundredths of the
  truth's except one:** the side pair's slope with x reads 5 to 10% too steep
  at the 50-degree views (−1.34 against −1.22, −1.22 against −1.13). Its
  readings carry an error that grows as the top cube slides back -- the
  ledge, where the gap is too narrow (under 2 px) for the ledge detector to
  see it -- and a one-sided error fitted with a line is a slope. That is what
  is left of x.
- **Leaving ledge frames out of the fit** corrects the slope at 20 degrees,
  where they are detected, and not at 50, where they are not; the test poses
  did not change. Not kept.
- **Weighting the solve by each reading's calibration scatter** (0.016 to
  0.13 px) made every axis worse, x to 0.33 mm and the turn to 0.29
  degrees: the readings it marks down are the end readings, which carry the
  turn. Not kept; the scatter is reported.

#### An eighteenth: render noise, and one still edge for every run

Every number above came from one render of each pose. The ten test poses
were rendered twice more (`stack-2g-test-r2`, `-r3`), the same shots;
three-gpu-pathtracer draws its samples from `Math.random` unless
`stableNoise` is set, and pt-lab does not set it, so each render is the
same scene under independent noise. Each error splits into the part every
render repeats (bias, the RMS over poses of the three renders' mean) and
the part that changes (scatter, the pooled SD across renders):

| tracked readings, px | bias | scatter |
|---|---|---|
| pair 1, middle / ends | 0.035 / 0.04 | 0.022 / 0.04-0.05 |
| pair 2, middle / ends | 0.076 / 0.08 | 0.017 / 0.035-0.040 |

Solved, all four views, mm and degrees: x 0.070 bias / 0.023 scatter, y
0.017 / 0.016, z 0.050 / 0.023, turn 0.020 / 0.025. **x and z are mostly
error the scene repeats; y and the turn are at the noise.** Detections are
1 px of bias against 0.02-0.05 of scatter -- the push-apart is steady,
which is why calibrating them helped so much.

The one thing that moved between renders more than a reading did was **the
frame each pair was carried from.** The source is the median of a run's own
clean frames, and with three to seven candidates noise reorders them: four of
eight view-pairs changed source between renders, and 35/50's side pair had
one in the first render (gain 1.17, just under 1.2) and none in the other two,
so it fell back to the refit.

The still part and the cameras are the same in every run, so a view's still
edge is one line, and any run's clean frames are evidence of it. **`gap-sweep
--carry-from <dir>`** takes the candidates from the runs named -- this one's
own only if its own directory is among them -- matched to this run's pairs by
the angle they run at, ordered canonically, and takes the median as before.
Given the same list, the x, y, z and turn sweeps and the three test renders
all choose the same eight frames: 15 to 19 candidates each at 20 degrees, but
1 to 5 at 50, where few frames read a pair 3 px wide. Every view-pair has a
source, 35/50's side pair now reads in 33 of 39 rows instead of 28, and
the ends' scatter on pair 2 halves (0.04 → 0.017 px), the source no longer
moving under them.

Measured against the truth, the pooled edge is no better: its median sits
further from the true edge on pair 2 (bias 0.08 → 0.11 px), and x gets worse
(0.07 → 0.10 mm, four views). But the same edge is held in the calibration
sweeps, so its offset is in the readings the calibration is made from, and
**a calibration from the readings absorbs it.** Test poses, three renders,
x / y / z mm and turn degrees:

| | eleven sets | ten (not 35/50 + 60/50) | four views |
|---|---|---|---|
| own frames, truth | 0.10 / 0.06 / 0.07 / 0.04 | 0.09 / 0.04 / 0.06 / 0.04 | 0.07 / 0.02 / 0.05 / 0.03 |
| pooled, truth | 0.13 / 0.07 / 0.07 / 0.04 | 0.13 / 0.04 / 0.06 / 0.04 | 0.10 / 0.03 / 0.04 / 0.04 |
| **pooled, joint -- no truth** | 0.14 / 0.13 / 0.11 / 0.03 | **0.10 / 0.04 / 0.06 / 0.03** | **0.08 / 0.02 / 0.04 / 0.03** |

The seventeenth's no-truth result was 0.19 / 0.09 / 0.10 and 0.06 over the
eleven, 0.18 / 0.05 / 0.08 and 0.06 from four views. With one still edge for
everything, **no truth is as good as truth.**

- **The two high views alone are the exception.** 35/50 + 60/50 solves pose 5
  (2.5, 2.5, 0.8 mm) 2.5 to 5 mm off in two renders of three, under the joint
  calibration: one reading off with nothing to outvote it, in the set with the
  weakest geometry. It is the whole difference between the eleven and the ten.
  A solve that checks its own residuals would refuse it; nothing does yet.
- **Render noise is not what limits this.** What is left in x is repeated
  from render to render and from pose to pose: the side pair's narrow-gap
  ledge (the seventeenth).

#### A nineteenth: the ledge is one-sided, so calibrate it as one

Under the pooled calibration the side pair's slope with x is steep in every
view, not only at 50 degrees: 3% at 20, 5-6% at 50. Split into its edges
along the x sweep, the held still edge is a constant (0.10 to 0.21 px a view,
which the calibration absorbs) and the error is the MOVING edge's: −0.03 to
+0.07 px at flush and overhanging, then +0.04 to +0.14, +0.12 to +0.32 and
+0.19 to +0.36 px at 1, 2 and 4 mm slid back. It is the fifteenth again, beside the other
edge: slid back past flush, the base's top face shows inside the gap, in the
top cube's soft shadow, and the ramp moves the top cube's fitted edge. It is
not the narrow-gap case the seventeenth guessed; it is every slid-back frame.

An error on one side of flush only, fitted with one line through both, is a
steep line, wrong at both ends. **`--calibrate hinged`** is the joint fit
with two more columns per reading -- min(x, 0) and min(z, 0) -- so each
reading gets a second slope that applies only below zero, measured the same
way, with no truth. `solveHinged` (src/lab/position.js) solves the piecewise-
linear model exactly on a side and re-solves until no axis changes side.

With the hinge, the side pair's slope above zero matches the truth's to 0.5%
at 20 degrees and 1.5% at 50 (it was 3-6% steep), the hinge is −0.03 to
−0.065 px per mm on every side-pair reading, and the front pair at 60/50
gets a z hinge of +0.07 to +0.10, its own milder ledge. Everything else is
under 0.02. Test poses, three renders, no truth, x / y / z mm and turn
degrees:

| calibration | ten sets | four views | four views, x bias / scatter |
|---|---|---|---|
| joint | 0.095 / 0.035 / 0.057 / 0.033 | 0.081 / 0.023 / 0.042 / 0.029 | 0.077 / 0.030 |
| **hinged** | **0.074 / 0.035 / 0.052 / 0.032** | **0.051 / 0.023 / 0.035 / 0.027** | 0.045 / 0.032 |

x's repeated error falls from 0.077 to 0.045 mm, near its noise (0.032).

**Corners were the other idea for x, and are not worth adding.** Over the
1,402 corners the test renders matched to the truth, the median distance is
0.31 px, quartiles 0.12 and 0.73: ten times an edge-pair reading's error. A
corner is also an absolute image position, which a camera that moves or a
lens model that is off shifts, where a gap is a difference that cancels
both. Weighted for what they are, they would not move a solve the edge pairs
already make to 0.05 mm.

#### A twentieth: the 50-degree views, and a refusal that refused nothing

The sixteenth left two things about the 50-degree views. Both are answered.

- **Views with nothing to carry from** have something now: the pool of the
  eighteenth gives every view-pair a source, 1 to 5 candidates at 50 degrees.
- **The y sweep's side pair, worse when held** (0.108 → 0.124 px RMS against
  the truth), is the held edge's constant offset, 0.10 to 0.21 px a view.
  With each view's mean error taken out -- which is what a calibration does
  -- the held reading is the better one on every sweep: side pair on the y
  sweep 0.032 → 0.009 px, on x 0.134 → 0.071, front pair on y 0.031 →
  0.014. Measured against the truth an offset looks like error; it is not one
  a calibrated solve sees.

What the 50-degree views did show was the two of them alone, 35/50 + 60/50,
solving pose 5 (2.5, 2.5, 0.8 mm) 2.5 to 5 mm off in two renders of three.
At that pose the side pair at 35/50 is never found, and the front pair at
60/50, an overhang of −0.14 px, is read in one render of three. What is left
is two pairs: two directions and, through their ends, the turn. The third
direction rests on the small difference between a pair's ends.

`--max-sigma` exists to refuse exactly that -- a pose solved from readings
that turn a pixel of error into more than 10 mm -- and refused nothing. It
compared the WEIGHTED solve's sigma, and with weights of 1/gapSigma^2
(gapSigma ~0.015 px) that sigma is scaled down by the weights until no pose
ever exceeds it. It now judges the readings the pose has, unweighted, which
is the unit the option is in. The two failing solves are refused, and the
mean over the eleven sets, hinged, no truth, goes from 0.114 / 0.112 / 0.091
mm and 0.033 degrees to **0.077 / 0.050 / 0.055 and 0.033**; four views are
unchanged. A tighter limit (3, then 2) refuses 16, then 46, of the 330, and
the means hardly move. The sequences already scaled theirs correctly.

#### A twenty-first: under a third of a pixel, two readings and a prior

With the pooled edge held, the approach (`stack-2g-approach`, 5 mm down to
contact) reads every view's pairs down to about 0.4 px: 0.41 as 0.40, 0.33
as 0.36. Below that `trackPair` gave nothing, on purpose: between a strip
and one edge the fit ratio is 1.0 to 1.2, a real 0.3 px gap and a 0.4 px
overhang look alike, and a reading that may be half a pixel off either way
is not one. Six readings of the approach fell there: 0.17 to 0.34 px at
the 50-degree views, and contact in two of them.

One frame cannot settle it. A sequence can: the pose carried from the last
frame predicts each gap, and the two readings are far apart. So in that
zone `trackPair` now returns `model: 'ambiguous'`, no gap, and both
readings as `hypotheses`, each with its gap and moving line; gap-sweep's row
carries them under `tracked.hypotheses` with `gapPx` null, so anything that
reads a gap still sees none. On the approach:

| view, pair | true | strip | one edge |
|---|---|---|---|
| 35/50, 1 at 0.5 mm | 0.31 | 0.30 | −0.46 |
| 35/50, 2 at 0.5 mm | 0.20 | 0.23 | −0.39 |
| 60/50, 1 at 1 mm | 0.34 | 0.36 | −0.41 |
| 60/50, 1 at 0.5 mm | 0.17 | 0.20 | −0.30 |
| 35/50, 2 at contact | 0 | 0.06 | −0.11 |
| 60/50, 1 at contact | 0 | 0.03 | −0.04 |

The strip is the truth every time, to 0.06 px, and the other reading is 0.5
to 0.8 px away until contact, where both are within 0.11 of zero. A prior
good to 0.1 px separates them; `npm run servo` takes the hypothesis its
prior predicts when the other is at least three predicted sigmas further
off, and otherwise neither. The overlay draws both hypotheses' edges.

#### A twenty-second: the estimate drives the motion

Every number so far was a pose the part was PUT at. **`npm run servo`** runs
the other way round, as a robot would: render the part where it really is
(gap-sweep, one pose, four views, the pooled still edges), solve its pose
against a saved calibration (`position --save-calibration`; joint or hinged,
no truth) with the last estimate moved by the last commanded move as a
prior, command a correction, and go again, down to contact. The simulated
robot misses each move by a fixed scale error per axis (sd 2%) and 0.02 mm
of noise per move; it starts believing a pose 1 mm off the real one; it is
never told the truth, which the script keeps only to score.

The policy: align x, z and the turn at the hover height (4 mm), descend at
most `--descend` a step once the estimated alignment is within 0.15, and go
to contact from under `--final`. Two starts, each with its own robot (seeds
1 and 2, so the policies on one start see the same robot); final error, x /
y / z mm and turn degrees:

| start | calibration, policy | renders | at contact |
|---|---|---|---|
| (1.5, 6, −1.2), 1.5° | joint; correct everywhere | 4 | 0.11 / 0.00 / 0.03 / −0.01 |
| | hinged; correct everywhere | 3 | 0.04 / 0.00 / 0.04 / 0.00 |
| | hinged; no lateral moves under 2 mm | 3 | 0.03 / −0.02 / 0.04 / −0.01 |
| | the same, 1 mm steps, contact from 0.6 | 5 | 0.03 / 0.06 / 0.03 / 0.02 |
| (−2, 7, 1.8), −2.5° | hinged; correct everywhere | 4 | 0.07 / 0.04 / 0.05 / 0.00 |
| | hinged; no lateral moves under 2 mm | 4 | −0.01 / 0.03 / 0.05 / 0.02 |
| | the same, 1 mm steps, contact from 0.6 | 5 | 0.00 / 0.02 / 0.10 / 0.00 |

- **It works, from the first try:** 3 to 5 renders from 2 to 3 mm and 2.5
  degrees off, to contact within about 0.05 mm on each axis.
- **Every estimate made 2 mm up or more is within 0.03 mm and 0.02 degrees
  of the truth**, frame after frame. What the part ends at is the robot's:
  the moves after the last estimate, 0.02 mm of noise each and the scale
  error on the last descent. The 0.10 in z is one noise draw of 0.072 mm,
  3.6 sigma, the same in no other run (the 112 draws have sd 0.019).
- **About 1 mm up, x reads 0.06 to 0.10 mm off in every run** -- the same
  sign, the same size, under both calibrations. It is not noise; it is the
  calibration, measured with the cube lifted 4 mm, used at 1: how a gap
  answers to x changes with the lift, and the model is linear about one
  pose. A robot that corrects sideways on that estimate ends 0.07 to 0.11
  off. One that stops correcting sideways under 2 mm ends where the higher
  estimates put it. That is `--lateral-floor 2`, and it is a policy that
  follows from what the measurement is good at, not a fix.
- **The two-hypothesis readings of the twenty-first are used.** At about 1
  mm, six readings a frame came back ambiguous, and the prior resolved all
  six in both runs that went that low.
- **The hinged calibration's gain is real in the loop:** the same start and
  robot under the joint one ends 0.11 off in x, against 0.04.

#### A twenty-third: further from the reference

The calibration is linear about one pose, measured over ±4 mm of x and z,
−2 to +4 of lift and ±3 degrees of turn. Twelve poses outside that were
rendered (`stack-2g-large`) and solved from all four views, hinged, no
truth, x / y / z mm and turn degrees:

| pose | as read, pairs within 5° | pairs within 12° |
|---|---|---|
| ±5 mm in x, ±5 in z, 10 up, (6, 9, −5) | all within 0.10 / 0.05 / 0.07 / 0.02 | the same |
| turned 5° | −0.10 / 0.00 / 0.01 / −0.09 | −0.16 / 0.01 / 0.02 / −0.08 |
| turned −5° | −0.01 / −0.02 / −0.08 / 0.19 | −0.03 / −0.05 / −0.12 / 0.18 |
| (3, 8, −3), 4° | 0.00 / −0.08 / 0.08 / −0.18 | 0.06 / −0.04 / 0.12 / −0.04 |
| (−4, 7, 4), −6° | not solved | 0.24 / −0.25 / −0.24 / 0.39 |
| (−3, 5, 2), 7° | **−98 / −49 / −96 / −2.2** | 0.25 / 0.07 / 0.23 / −0.33 |
| turned 8° | 3.3 / 1.7 / 3.6 / −0.31 | 1.2 / 0.44 / 0.58 / −0.34 |

- **Translation is not a limit.** Six millimetres sideways and ten up, past
  every calibration frame, solve as well as the test poses do: perspective
  bends the readings less than they scatter.
- **Turning is, and first through the harness.** gap-sweep makes a row only
  for a truth pair whose edges are parallel within `maxAngle`, 5 degrees; a
  pair turned past that has no row, and its track's reading never reaches
  the solve. `gap-sweep --max-angle 12` keeps them, and the 7-degree pose
  goes from 98 mm off to 0.25. The 98 was solved from three pairs whose
  geometry passed the twentieth's check. A check of the readings'
  residuals does not separate it cleanly: good four-view solves run 0.02
  to 0.06 px RMS, the bad large ones 0.47 to 0.60 -- and so does one
  ordinary test pose, (2, 4.5, 0) at −3 degrees, 0.51 px for an error of
  0.17 mm. `--max-residual` is there, off. A solve that drops the reading
  it disagrees with most -- three robust sigmas, up to three rounds -- was
  tried next and does not help: test poses the same or worse (four views,
  x 0.039 -> 0.055 mm on the first render), the large poses unchanged.
  What it drops is mostly end readings, which carry the turn -- the
  seventeenth's weighting failed the same way. Not kept.
- **Then through the image.** Turned 7 or 8 degrees, the top cube's edge
  crosses the base's in the 50-degree views: one end of a pair reads −2 to
  −4 px and the other +6 to +10. That is not a gap along its length, and
  `trackPair`, which fits a strip, gives nothing. Two of eight readings are
  left at 8 degrees.
- **The 1 mm x error of the loop** (the twenty-second) is the same thing in
  the other direction: how a gap answers to x depends on the lift, and the
  model has no term for it. It costs nothing at 6 mm sideways and 10 up, and
  0.06-0.10 mm at 1 mm up, where the gaps are narrow and every view leans on
  them.
- **Tipping** -- turning about a horizontal axis -- was not rendered:
  gap-sweep's poses turn about the vertical only.

**Closed, the range stops mattering.** Three servo loops started where one
shot is poor (hinged, lateral floor 2 mm, its own robot each):

| start | first estimate off by | renders | at contact |
|---|---|---|---|
| (0, 6, 0), 8° | 1.06 / 0.45 / 0.79 mm, 1.38° | 6 | −0.01 / −0.01 / −0.01 / 0.05 |
| (−4, 8, 4), −6° | 0.19 / 0.26 / 0.38 mm, 0.55° | 5 | −0.01 / −0.06 / −0.02 / −0.03 |
| (6, 9, −5), 0° | 0.05 / 0.02 / 0.01 mm | 3 | −0.05 / −0.06 / 0.01 / −0.01 |

A first estimate that is wrong but points the right way is enough: one
correction brings the part inside the calibrated range, and from there the
loop is the twenty-second's. From 8 degrees it took two corrections to be
within 0.04 mm.

#### A twenty-fourth: images more like a camera's

The renders are noiseless, sharp to the pixel and sRGB-encoded exactly as
the lab decodes them. **`npm run degrade`** copies a rendered run -- shots,
truth and AOV passes -- with its images made more like a camera's, in
linear light: radial distortion (bilinear resampling), Gaussian blur, shot
and read noise, and a response curve the lab does not undo. gap-sweep then
analyses the copy with `--skip-render`. Every sweep and the first test
render were degraded alike, analysed with the pooled edge, and solved with
no truth (hinged), x / y / z mm and turn degrees:

| image | aperture measured | ten sets | four views |
|---|---|---|---|
| as rendered | 1.30-1.38 px | 0.061 / 0.034 / 0.052 / 0.026 | 0.039 / 0.023 / 0.034 / 0.020 |
| γ 2.2 written, sRGB read | | 0.062 / 0.038 / 0.056 / 0.027 | 0.039 / 0.024 / 0.037 / 0.021 |
| noise: 2,000 e⁻ full scale, read 0.002 | | 0.097 / 0.047 / 0.057 / 0.029 | 0.065 / 0.029 / 0.035 / 0.022 |
| distortion k1 −0.02 | 1.87-2.11 | 0.152 / 0.097 / 0.155 / 0.058 | 0.089 / 0.058 / 0.084 / 0.054 |
| distortion k1 −0.08 | 1.89-2.17 | 0.146 / 0.103 / 0.133 / 0.057 | 0.095 / 0.078 / 0.072 / 0.053 |
| blur σ 0.8 px | 2.82-3.01 | 0.189 / 0.083 / 0.098 / 0.099 | 0.170 / 0.072 / 0.065 / 0.074 |
| all four (k1 −0.08) | | 0.262 / 0.155 / 0.208 / 0.124 | 0.203 / 0.132 / 0.180 / 0.110 |

- **A response curve left in costs nothing.** The fit's levels are its own,
  and a calibration from the readings absorbs what is left. The open
  question of §11 about undoing a real camera's curve on load matters less
  for this measurement than it seemed.
- **Noise costs little**: signal-to-noise of 15 to 30 on the faces moves x
  from 0.039 to 0.065 and nothing else.
- **Blur is what costs, and "distortion" here is blur.** k1 −0.02 costs as
  much as −0.08 -- four times less distortion, the same error -- because
  what both did to the fit was the bilinear resampling's blur: the aperture
  the lab measures goes from 1.35 px to 2. A real lens's distortion is
  removed by calibrating it and was not measured cleanly here. Blur of 0.8
  px, ordinary for real optics, is the largest single cost: the measured
  aperture is 3.0 px (0.8 px of Gaussian on the 1.35 px box is a 3.08 px
  box of the same variance), and the side pair's error along the x sweep
  grows from +0.11 to +0.42 px at the widest slid-back gap. The fit models a
  pixel as a box, and a blurred ledge's ramp is wider still.
- So the next thing a real camera needs is not here: **a fit whose aperture
  is a Gaussian, or a measured PSF, rather than a box.** Undecided whether
  it is the shape or only the ledge being wider.

Combined, the worst case is about 0.2 mm and 0.12 degrees from four views,
no truth.

**A bad light, and telling it from the calibration.** stack-4's high light
(the 10-05 notes: the front pair reads the shadow under the top cube) was
rendered in full -- y, z, turn and test, beside its x sweep -- to ask
whether a calibration from the readings absorbs a shadow reading as it
absorbs the held edge's offset. It does not. Test poses, ten sets, mm and
degrees:

| | truth | joint | hinged |
|---|---|---|---|
| stack-2's light | 0.13 / 0.04 / 0.06 / 0.04 (pooled) | 0.08 / 0.03 / 0.05 / 0.03 | 0.06 / 0.03 / 0.05 / 0.03 |
| stack-4's light | 2.3 / 2.6 / 1.9 / 0.40 | 3.3 / 0.91 / 1.0 / 0.27 | 2.0 / 1.2 / 1.3 / 0.33 |

But the calibration knows. Each reading's RMS about its own fitted model,
over its own calibration frames, is at most 0.055 px under stack-2's light,
and at most 0.12 with blur, noise and resampling all applied; under
stack-4's the worst are 0.34 to 0.57 px, the median 0.07 to 0.09. Dropping
the readings over 0.1 or 0.15 px gets the turn back to 0.1 degree and
leaves position 0.3 to 2.7 mm off: what is left fits a straight model and
still is not the gap. So `position` now **warns**, naming the readings, when
a joint or hinged calibration has any over 0.2 px -- under stack-4's light
five, under stack-2's none, under every degraded image none. Detecting a
bad light needs no truth. Choosing a good one is still open.

#### findPairs' gain threshold, on more than two renders

`findPairs` calls a segment two edges when two steps fit its pixels
`minGain` (1.3) times better than one: a number set on two renders of one
scene. Run with the gate open (`minGain=1.0`) over sixteen runs -- every
stack-2 sweep and test render, stack-3's, stack-4's x sweep, and the gap
scene at 512 and 2048 px, 1,085 candidates -- a find counts as real when
two visible truth edges lie under its two lines (within 0.6 px and 5
degrees):

| gain | real | not |
|---|---|---|
| 1.00-1.15 | 18 | 1,000 |
| 1.15-1.30 | 2 | 10 |
| 1.30-1.50 | 11 | 19 |
| 1.50 and up | 19 | 6 |

At 1.3 it keeps 30 of the 50 real pairs and 25 others; 1.2 would add one
real and nine others, 1.5 lose eleven real and nineteen others. **Every one
of the 25 is a real cube silhouette with a second image edge 1.2 to 2.4 px
beside it that no mesh edge accounts for** -- a shadow line, which is in the
image and not in the geometry. So 1.3 holds on sixteen runs, three lights
and two sizes; what it cannot do is tell a gap from a shadow beside an edge,
and nothing that sees only pixels can. In the renderer `explain` can.
(`notes/brads-notes/2026-10-05-findpairs/`.)

#### A twenty-fifth: a pixel shaped like a lens's blur

Blur was the largest cost of a camera-like image (the twenty-fourth: 0.8 px
of Gaussian took four-view, no-truth x from 0.039 to 0.170 mm), and the fit
models a pixel as a box. `fitPairs`, `findPairs` and `trackPair` now take
**`profile: smooth`**: the projected unit pixel convolved with three equal
boxes -- a quadratic B-spline, Gaussian-like and still piecewise polynomial,
so the no-transcendentals rule holds. The aperture keeps its meaning, the
width of the box with the same spread, so the two profiles' numbers compare;
at an aperture of 1 or less the profile is the box.

**The shape is right.** On a strip area-sampled exactly and blurred by a
sampled Gaussian, with each profile's aperture measured on a lone edge of the
same image, as the pipeline does, the smooth profile reads gaps of 2 to 4 px
at 7 to 30 degrees to within 0.004-0.065 px at sigma 0.8 and 1.0; the box
errs by up to 0.24 px, and by an amount that changes with the gap, which no
calibration removes. It fits the pixels three times better.

**On the stack's blurred renders it does not help**, and why is the useful
part. Test poses, no truth (hinged, pooled still edge), x / y / z mm and
turn degrees; "ten sets" is the RMS over every multi-view set but the weak
35/50 + 60/50 pair:

| | ten sets | four views |
|---|---|---|
| clean, box | 0.064 / 0.037 / 0.060 / 0.026 | 0.039 / 0.023 / 0.034 / 0.020 |
| clean, smooth | 0.068 / 0.042 / 0.068 / 0.026 | 0.036 / 0.024 / 0.037 / 0.019 |
| blur 0.8, box | 0.197 / 0.088 / 0.101 / 0.104 | 0.170 / 0.072 / 0.065 / 0.074 |
| blur 0.8, smooth | 0.219 / 0.177 / 0.302 / 0.112 | 0.123 / 0.094 / 0.117 / 0.103 |
| blur 0.8, box, aperture per pair | 0.185 / 0.111 / 0.163 / 0.086 | 0.140 / 0.064 / 0.090 / 0.065 |
| blur 0.8, smooth, aperture per pair | 0.178 / 0.105 / 0.143 / 0.093 | 0.124 / 0.079 / 0.111 / 0.086 |

- **The aperture, measured on the image's lone segments, is too wide under
  the smooth profile**: 3.23 px median on the blurred renders, where the
  pairs themselves say 2.95-3.05. Real lone edges -- a table's, a shadow's --
  have tails a step does not, and the smooth model turns tails into width
  where the box ignores them. It is steep: held at 2.8, 2.9, 3.0, 3.1 and
  3.2 px, the blurred front pair's refit error runs 0.175, 0.077, 0.061,
  0.218, 0.310 px RMS, about a tenth of a pixel of gap per tenth of a pixel
  of aperture. At the right width the smooth profile reads that pair better
  than the box (0.061 against 0.092, non-linear part 0.021 against 0.031).
- **Measuring it on the pair itself** -- where the gap is wide, the two edges
  pin it as a lone step does -- gives the right width. One aperture per image
  from all its wide pairs jumps from frame to frame (shadow lines join in;
  the clean front pair went 0.029 -> 0.074 px). Each pair its own, gated on
  the DETECTED gap, fails on true gaps of 1.4 px detected wider; gated on the
  fitted gap (at least 2 px and 1.2 apertures) and carried to the narrow
  frames by `--carry`, it is the last two rows: no consistent gain. Not kept.
- **What blur costs in the solve is the ledge, not the shape.** The front
  pair's carried readings barely change under blur: along the x sweep, their
  error relative to flush moves by at most 0.03 px more than unblurred, and
  the part of it not straight in the gap is 0.023 px against 0.031. The side
  pair's error on the slid-back side -- the ledge in soft shadow, the
  fifteenth -- doubles: at -4 mm +0.23 -> +0.47, +0.31 -> +0.62, +0.18 ->
  +0.42, +0.30 -> +0.67 px in the four views, and its non-straight part goes
  0.029 -> 0.075. The front pair's blur bias is nearly straight in the gap,
  and the no-truth calibration takes it out whatever the profile. Some 50°
  side-pair frames also flip by 0.2 px under blur where the gap is under a
  pixel and a half: there the strip-or-edge choice was set on sharp images.

So the profile stays, opt-in, for an image whose edges are cleaner than its
lone segments' median; the default stays the box. What a blurred camera needs
next is the ledge read under blur, and a way to measure the aperture on the
edges that matter. (`notes/brads-notes/2026-10-06-aperture/`.)

#### A twenty-sixth: lens distortion, without the resampling blur

The twenty-fourth's distortion was bilinear resampling of a 512 px render,
and the resampling's blur (aperture 1.35 -> 2.0 px) was all it measured.
Now every stack-2 sweep and test pose was rendered at 1024 px, distorted at
that size with Catmull-Rom interpolation (which adds no spread to second
order), and averaged 2 x 2 down to 512 (`npm run degrade -- --downsample 2
--interp cubic`). The control is the same renders shrunk with no
distortion. Measured aperture: 1.11-1.14 px for the control, 1.19-1.22 at
k1 -0.02 and 1.21-1.32 at -0.08, against 2.0 for bilinear. Test poses, no
truth, four views (ten sets):

| k1 | hinged | joint |
|---|---|---|
| 0 (control) | 0.067 / 0.033 / 0.050 / 0.024 (0.088 / 0.049 / 0.072 / 0.031) | 0.089 / 0.024 / 0.033 / 0.031 |
| -0.02 | 0.065 / 0.030 / 0.048 / 0.030 (0.090 / 0.050 / 0.071 / 0.033) | 0.088 / 0.022 / 0.034 / 0.034 |
| -0.08 | 0.078 / 0.031 / 0.047 / 0.028 (0.102 / 0.050 / 0.064 / 0.031) | 0.090 / 0.024 / 0.035 / 0.031 |
| -0.3 | 0.122 / 0.103 / 0.194 / 0.163 (0.117 / 0.090 / 0.167 / 0.154) | 0.147 / 0.056 / 0.115 / 0.103 |

- **Up to k1 -0.08 the calibration absorbs it.** The stack's pairs sit 0.14
  to 0.23 of the half-width from the centre; at -0.08 that moves them 0.06
  to 0.25 px and scales their gaps by about 1% -- 0.05 px on a 5 px gap,
  nearly the same in every pose of a view, which is what a calibration from
  the readings takes out. Their RMS about their own calibration does not
  move (median 0.014-0.016 px).
- **At -0.3 it does not**: two to six times the error, the turn worst. The
  scale now changes along a pair, and the turn is read off its ends.
- So the lab needs no undistort step for a mild lens and parts near the
  middle of the picture. A strong lens, or parts near the edge of it, want
  the lens calibrated and the image (or the edges) undistorted before
  anything is read; that is the standard camera calibration and was not
  built here.

The hinged calibration also dropped whole readings here -- 4 of 24 in the
control, 6 at -0.08 -- where a reading's frames could not pin its
one-sided slope, every frame on one side of flush having lost the pair. It
now falls back to the joint fit for that reading instead of dropping it,
which is the ten-set column above (it was 0.100 / 0.066 / 0.112 for the
control). Stack-2's own runs are unchanged by it.

Not explained: the control, sharper than a native 512 px render (aperture
1.12 against 1.35) and less noisy (four times the samples a pixel), does not
solve better -- y and z 0.033 / 0.050 mm against 0.019-0.023 / 0.021-0.023
over three native renders. It is the right control for distortion, which is
all it is used for here. (`notes/brads-notes/2026-10-06-distort/`.)

#### A twenty-seventh: a calibration that knows the height

The twenty-second's loops read x 0.06 to 0.10 mm off at about 1 mm up, in
every run, and put it down to a calibration measured at a 4 mm lift; the
loop's policy stops correcting sideways below 2 mm (`--lateral-floor 2`).
To test that, the x, z and turn sweeps were rendered again at 1.5 mm, and
eight test poses 0.6 to 2.5 mm up. `position --lift <dir>` adds such sweeps
to a joint or hinged calibration, which then fits each reading's slopes in
x, z and the turn as changing with the lift (a y*x, y*z, y*turn term each),
and the hinge's one-sided slopes too (y*min(x,0), y*min(z,0)): the ledge's
penumbra depends on the height. The model is bilinear, and `solveLifted`
solves it by Gauss-Newton on the hinged solve.

| low test poses, four views, no truth | x / y / z mm, turn deg |
|---|---|
| calibrated at 4 mm | 0.114 / 0.059 / 0.049 / 0.049 |
| lift terms on the slopes | 0.109 / 0.070 / 0.082 / 0.030 |
| and on the hinges | 0.109 / 0.050 / 0.056 / 0.031 |
| the same, the renderer's true gaps as readings: 4 mm / lifted | 0.023 / 0.025 / 0.041 / 0.024 -> 0.024 / 0.011 / 0.022 / 0.016 |

**The model was not the problem.** With true gaps as the readings the lift
terms halve what a 4 mm calibration gets wrong near contact, but that was
0.02 to 0.04 mm. With the readings themselves the error is five times that
whichever calibration: the side pair over the ledge, slid back, reads 0.2
to 0.44 px short at 0.8 mm up, and the overhanging side pair in the
50-degree views 0.13 to 0.22 px too negative. That is below the 1.5 mm the
lift was calibrated at, so the lift terms extrapolate there, and it is a
reading's error, not a slope's. Ordinary test poses are unchanged by the
lift terms (0.025 / 0.018 / 0.018 / 0.021).

**In the loop**, with sideways correction allowed all the way down
(`--lateral-floor 0`), from the twenty-second's two starts, the estimate at
about 1 mm up and where the part ended:

| calibration | start | x error at ~1 mm | final pose |
|---|---|---|---|
| at 4 mm | A | (went from 2.5 mm to contact) | 0.04 / 0.01 / 0.04 / 0.01 |
| at 4 mm | B | -0.05 | 0.05 / 0.00 / 0.02 / 0.00 |
| with lift terms | A | -0.09 | 0.09 / 0.01 / 0.05 / 0.01 |
| with lift terms | B | -0.06 | 0.06 / 0.05 / 0.10 / 0.03 |

The 0.06-0.10 mm at 1 mm of the twenty-second is mostly gone without any
lift terms: the occluding track (the twenty-ninth) took it to 0.05. The
lift terms do not help in the loop, and are not used by default; the option
stays for a scene whose slopes really do change with the height. The final
poses are the robot's last moves as much as the camera's. Stopping sideways
correction below 2 mm still saves the last 0.05 mm, at no cost, so the
floor stays where it was. (`notes/brads-notes/2026-10-06-lift/`.)

#### A twenty-eighth: tipping

Never rendered until now: `gap-sweep --poses` takes `x,y,z,turn,tipX,tipZ`,
the moving part's Euler rotation about its own centre. A sweep of tips about
x and one about z (-2 to +2 degrees, at the reference pose), and eight test
poses mixing tips up to 1.5 degrees with offsets and turns.

**The pairs read a tip as faithfully as they read a turn.** A tip about x
leaves the front pair's two ends together and moves its middle (by up to
0.8 px per degree), and spreads the side pair's ends apart, 0.5 to 1.4 px
per degree; a tip about z does the reverse. Read against the truth, the
spread follows to 0.02 px per degree in every view. A turn spreads both
pairs at once, so a turn and two tips are three different patterns, and
the ends see all three.

**Ignored, a tip is ruinous.** Solved with the four unknowns, no truth,
four views, the tipped test poses come out 0.61 / 0.65 / 0.65 mm and 0.50
degrees off: about half a millimetre per degree of tip, all of it pushed
into position and the turn.

**As unknowns, tips are determined.** `position --tipx --tipz` adds them,
calibrated from the two sweeps like the turn. Four views, no truth:

| | test poses (untipped) | tipped test poses |
|---|---|---|
| four unknowns | 0.026 / 0.019 / 0.023 / 0.019 | 0.61 / 0.65 / 0.65 / 0.50 |
| six unknowns | 0.050 / 0.058 / 0.035 / 0.014, tips 0.05 | 0.096 / 0.046 / 0.054 / 0.032, tips 0.06 / 0.05 |

Two more unknowns from the same readings cost precision when nothing is
tipped (sigma per px 0.4 -> 0.6). **`--tip-prior <deg>`** puts what is known
before looking -- zero, to how level a gripper holds a part -- against the
readings, weighed absolutely (`--reading-sigma`, 0.1 px at the median
gapSigma). Untipped / tipped, four views:

| tip prior | untipped | tipped |
|---|---|---|
| 0.05 deg | 0.031 / 0.032 / 0.021 / 0.016 | 0.38 / 0.39 / 0.38 / 0.27 |
| 0.3 deg | 0.048 / 0.056 / 0.033 / 0.014 | 0.099 / 0.053 / 0.060 / 0.029 |
| 1 deg | 0.050 / 0.058 / 0.035 / 0.014 | 0.096 / 0.046 / 0.054 / 0.031 |

So a tip needs its own unknowns whenever a part can sit in the gripper more
than about a tenth of a degree off level, with the prior set to what the
gripper really does: a tight prior on a tipped part is as wrong as no tip
unknowns at all. (Weighed against a prior, the readings' 1/gapSigma^2
weights were first used as they stand; gapSigma, ~0.02 px, is a fifth of a
reading's real error, and no prior moved anything.)
(`notes/brads-notes/2026-10-06-tip/`.)

#### A twenty-ninth: past seven degrees, the edges cross

Turned past about five degrees, the stack's pairs stop being parallel in the
higher views, and past seven their edges cross inside the stretch they share
(the twenty-third): the gap is open at one end and closed at the other. Two
things refused them. `fitPairs` pairs only segments within `maxAngle` (5
degrees) of parallel, so at 8 degrees even the 20-degree views' wide pairs
were not refitted. And `fitBand` refused any band whose edges cross, so
`trackPair`, which holds the still edge and fits only the moving one,
returned nothing for every crossed pair -- in the 50-degree views already at
5 degrees.

**The moving part is in front.** Past the crossing its face covers the still
edge and there is no strip: a pixel's strip share is max(0, beyond the still
edge - beyond the moving edge), not the difference. Where the edges do not
cross that is the model as it was, exactly; where they do, it describes the
crossed end instead of being refused. `fitBand` takes the occluding edge
(`occluder`) and clamps the other's coverage to it, Jacobian included;
`trackPair` names the moving edge. It also starts its fits turned either way
(0.075 and 0.15 px per px) as well as parallel: a strongly turned edge
otherwise settled on a near-parallel strip 0.56 px wide for a true 1.25,
which fitted no better than one edge. And a two-edge fit whose moving edge
is past the still one along the whole band is the one-edge model in
disguise -- no pixel sees its strip -- so it is not counted as a strip
reading, and an overhang still reads as an overhang.

On `stack-2g-large`'s turned poses (5 to 8 degrees, 39 pair-views), tracked
readings go from 17 to 38, nearly all within 0.1 px, ends past the crossing
included (-4.48 px read -4.50). From four views, no truth (hinged), all
twelve large poses solve; the 8-degree pose is 0.39 / 0.07 / 0.10 mm and
0.21 degrees, where the twenty-third had 1.2 mm.

**And ordinary poses were crossing too.** A 50-degree view's pair crosses at
a turn of a degree or two near its ends. Re-analysed, the stack-2g turn
sweep has 40 tracked readings where it had 31, the test poses 75 where they
had 65, and the test poses solve better -- with no truth, four views:

| | ten sets | four views |
|---|---|---|
| before | 0.064 / 0.037 / 0.060 / 0.026 | 0.039 / 0.023 / 0.034 / 0.020 |
| occluding track | 0.049 / 0.034 / 0.052 / 0.026 | 0.026 / 0.019 / 0.023 / 0.019 |

That render was the lucky one. The same ten poses rendered twice more (the
eighteenth's repeats), re-analysed, give 0.039 / 0.020 / 0.021 / 0.022 and
0.059 / 0.023 / 0.023 / 0.016 from four views: over three renders, x 0.026
to 0.059 mm, y 0.019 to 0.023, z 0.021 to 0.023, the turn 0.016 to 0.022
degrees, where the pooled edge and the hinge (the eighteenth and
nineteenth) had 0.04-0.05 / 0.02 / 0.035 and 0.02-0.03. So
z and the turn improved, and x is about where it was: what is left in x is
render noise, not crossing pairs.

Still open: one 8-degree side pair at 35/50 reads nothing (both hypotheses
wrong); a -6 degree pose's front pair at 60/20 reads 0.84 px wide, its band
holding something brighter than the still face -- the turned cube's corner,
by the levels; `fitPairs` still pairs nothing past `maxAngle`, which the
carried readings make matter less.

#### A thirtieth: choosing a light

The twenty-fourth detects a bad light from the calibration; nothing chose
one. A light is scored here as a cell could score it, with no truth in the
images: each reading's RMS about its own calibration fit (is it following
the pose in a straight line?), and the error on test poses the robot
commands, which a cell knows. Each candidate is the stack-2 sweeps and test
poses rendered under it, analysed with its own pooled still edge and solved
hinged (`notes/brads-notes/2026-10-06-light/light.sh`, `score.js`): about an
hour of rendering a light. Eight lights, all the same area light at the same
distance from the stack, placed by how far round from the front (the
cameras are at 35 and 60 degrees) and how far up:

| light: round / up | calibration RMS, max / median px | four views, no truth | ten sets |
|---|---|---|---|
| 45 / 5 (stack-2) | 0.033 / 0.018 | 0.026 / 0.019 / 0.023 / 0.019 | 0.049 / 0.034 / 0.052 / 0.026 |
| 45 / 10 | 0.075 / 0.026 | 0.026 / 0.031 / 0.059 / 0.022 | 0.068 / 0.042 / 0.067 / 0.036 |
| 45 / 20 | 0.64 / 0.051 | 0.94 / 0.29 / 0.19 / 0.08 | 1.9 / 0.49 / 0.71 / 0.09 |
| 42 / 45 (stack-4) | 0.115 / 0.068 | 1.2 / 0.94 / 1.1 / 0.10 | 2.1 / 0.95 / 1.1 / 0.16 |
| 60 / 5 | 0.040 / 0.022 | 0.24 / 0.11 / 0.08 / 0.03 | 0.24 / 0.11 / 0.11 / 0.04 |
| 70 / 6 (stack-3) | 0.059 / 0.025 | 0.33 / 0.15 / 0.20 / 0.06 | 0.35 / 0.17 / 0.21 / 0.07 |
| 15 / 10 | 98 / 0.031 | 1.6 / 1.0 / 1.3 / 0.79 | 2.1 / 1.1 / 1.3 / 0.59 |
| -30 / 10 | 42 / 0.031 | 1.7 / 1.1 / 1.4 / 1.1 | 5.6 / 1.0 / 1.3 / 0.93 |

- **Only a small region is good**: about 45 degrees round, between the two
  camera azimuths, and no more than 10 up. Raised to 20 it fails; moved 15
  degrees round either way it costs ten times or more.
- **Every failure is the side pair, and nearly always at 35/50.** Higher,
  the top cube's shadow falls where that pair is read; more frontal or from
  the far side, its faces lose their contrast and it reads something else
  (calibration RMS of tens of px: it is not following the gap at all).
- **Two kinds of bad light, and the calibration sees only one.** Lights that
  make a reading follow a shadow are caught by the calibration's RMS (the
  worst reading over 0.2 px, or the median over 0.05: four of the six bad
  lights). Lights that leave every reading straight but reading the wrong
  edge -- 60 and 70 degrees round, the eighth's crease with no contrast --
  are not: their readings follow the pose in a straight line, offset and
  scaled, and the calibration cannot tell that line from the right one. Only
  the commanded test poses can, and a cell can command them.
- So choosing a light is: candidate positions, a calibration under each,
  the warning as a first screen, and the commanded test poses as the
  verdict. Done here by rendering; in a cell, by moving the light. What it
  costs is the sweeps per candidate, and nothing here makes it cheaper.

The search also found a defect: gap-sweep --carry wrote a frame's own refit
gap into its trackPair command as the starting width, and under the light
from the far side one read an overhang, -0.60 px, which trackPair refuses;
the frame and its run failed. A reading that is not positive now starts the
fit at half a pixel.

**Cheaper, measured (2026-10-07).** Nothing in one frame tells the lights
apart. At the reference pose the two straight-but-wrong lights look like the
good ones by every measure that needs no truth -- each pair's `gapSigma`,
strip level, and ledge gain -- and differ only in the truth error, 0.15 to
0.23 px on the side pair (`cheap.js`). What does cost less is fewer frames
of the same search: the calibration from nine positions (the reference, and
one step either way along x, y and z and in the turn: +-2 mm, +-1.5
degrees) instead of 25, and the verdict from five commanded test poses
instead of ten, 14 positions in place of 35 (`subset.sh`, the full runs'
rows subset). No truth, hinged, x mm:

| light | full: four views / every set | 9 + 5: four views / every set | 9 + 3: every set |
|---|---|---|---|
| 45 / 5 | 0.026 / 0.049 | 0.023 / 0.077 | 0.037 |
| 45 / 10 | 0.026 / 0.068 | 0.148 / 0.160 | 0.094 |
| 60 / 5 | 0.244 / 0.242 | 0.336 / 0.341 | 0.221 |
| 70 / 6 | 0.325 / 0.346 | 0.416 / 0.351 | 0.136 |
| the four warned | 0.9 to 1.7 / 1.9 to 5.6 | 0.9 to 3.8 / 1.2 to 5.3 | 1.6 to 4.1 |

The same light is chosen, at 40% of the renders, and the margin from the
runner-up to the first straight-but-wrong light is 2.1x where the full
search had 3.5x. With only three test poses it is 1.4x, and from four views
alone 60/5 then reads 0.042 mm and passes: the verdict must be scored over
every set of views, where a bad light's damage shows in the pairs of views
that lean on its side pair. The second-best light loses most to the smaller
calibration (45/10: 0.026 -> 0.148 from four views): with one step either
side the hinge has one slid-back frame. So a search is the nine positions
and five test poses per candidate, and the full calibration only under the
light chosen.

#### A thirty-first: loose ends -- outliers, the weak pair, a calibration's own noise

**Outliers.** A solve that dropped the worst reading made things worse (the
twenty-fourth). `position --robust <px>` reweights instead, by Huber's rule:
a reading further than k px from its pose's solution keeps k/|r| of its
weight, for five rounds. Four views, no truth (ten sets):

| | off | k = 0.1 px |
|---|---|---|
| clean | 0.026 / 0.019 / 0.023 / 0.019 (0.049 / 0.034 / 0.052 / 0.026) | 0.026 / 0.019 / 0.024 / 0.021 (0.050 / 0.034 / 0.053 / 0.027) |
| noise | 0.058 / 0.029 / 0.028 / 0.018 (0.100 / 0.049 / 0.058 / 0.026) | 0.029 / 0.021 / 0.025 / 0.021 (0.082 / 0.044 / 0.056 / 0.028) |
| blur 0.8 | 0.120 / 0.053 / 0.074 / 0.030 (0.155 / 0.072 / 0.093 / 0.066) | 0.091 / 0.046 / 0.072 / 0.043 (0.153 / 0.077 / 0.117 / 0.079) |
| all four | 0.165 / 0.132 / 0.174 / 0.055 (0.317 / 0.218 / 0.344 / 0.079) | 0.146 / 0.101 / 0.162 / 0.040 (0.296 / 0.201 / 0.331 / 0.065) |

It helps where images are camera-like and changes nothing on clean renders;
under blur the ten-set z gets worse. An option, for real images, not a
default. On the turned large poses it fixes the turn of the one pose with a
bad reading (0.30 -> 0.12 degrees) and not its position.

**The weak pair of views, 35/50 + 60/50**, is geometry, and the design
sigma says so before anything is read: y gets 1.86 mm per px of reading
error from it, against 0.56 to 0.96 from every other pair. Two steep views
see height and sideways motion in nearly the same proportions. The two
20-degree views are weak the other way (x 1.61, z 1.42 mm/px). Pairs mixing
a low and a high view are the strong ones.

**A calibration's own noise.** Only the test poses had been rendered more
than once (the eighteenth). The four calibration sweeps were rendered a
second time, and each calibration (hinged, no truth) used on all three
renders of the test poses, four views:

| calibrated from | test render 1 | 2 | 3 |
|---|---|---|---|
| sweeps, render 1 | 0.026 / 0.019 / 0.023 / 0.019 | 0.039 / 0.020 / 0.021 / 0.022 | 0.059 / 0.023 / 0.023 / 0.016 |
| sweeps, render 2 | 0.062 / 0.025 / 0.030 / 0.021 | 0.051 / 0.030 / 0.027 / 0.020 | 0.079 / 0.032 / 0.031 / 0.015 |
| both (`--x a,b` ...) | 0.049 / 0.024 / 0.025 / 0.020 | 0.043 / 0.028 / 0.023 / 0.020 | 0.072 / 0.030 / 0.026 / 0.016 |

The two calibrations differ by 0.009 px in their references and about 1% in
their slopes (4% in x), and that is enough to move x by 0.03 mm. So the
number to quote is not the best cell: over both calibrations and all three
test renders, **0.055 / 0.025 / 0.026 mm and 0.019 degrees** RMS, x ranging
0.026 to 0.079. Calibrating from both renders together lands between them,
not below: more calibration frames do not obviously help at two renders.
What is left in x is the side pair's render-to-render scatter, the same
thing the eighteenth found in the test poses.
(`notes/brads-notes/2026-10-06-repeat/`.)

#### A thirty-second: the ledge, modelled

The side pair over the ledge was the largest error left everywhere: slid
back, under blur, near contact, under a bad light (the second cube list).
Holding the still edge (the sixteenth) and a one-sided calibration (the
nineteenth's hinge) had kept it out of the clean test poses at the lift the
sweeps were made at. Neither reaches near contact or blur. Here it is modelled
instead.

**The brightness across a slid-back gap is three levels, not one.** Binned
from the still edge (`2026-10-05-profile/profile.js`), slid 4 mm back at
35/20: the still face 0.325, then a plateau at 0.175 for about 3 px, a ramp
down over 1.5 px, the dark 0.07 and the moving face 0.23. The plateau is the
still part's top face, uncovered and lit; the ramp is where it passes into
the moving part's shadow. Fitted as one flat strip, the dark level comes out
too light and the moving edge too far out, the nineteenth's +0.2 to +0.36 px
at 4 mm back. The ramp's middle sits the same distance from the MOVING edge
at 2 mm back as at 4 (3.6 px at 35/20): the shadow moves with the part that
casts it.

`fitBand` takes a third, soft edge between the two for it (pairs.js): BOUNDED
by the still edge and the moving one, because a ledge ends at the still edge
and a shadow cannot pass the edge that casts it. Where it would, its coverage
is clamped and the lit level has no pixel, which is the plain model exactly.
`trackPair` reads with it as `ledge=fit`, placed freely, or `ledge=held`,
its middle `ledgeOffset` px from the moving edge and `ledgeWidth` wide, which
adds one level and nothing else.

**Freed per frame it fixes clean ledge frames and fails elsewhere.** On the x
sweep it takes the slid-back frames from +0.08 to +0.23 px to within 0.04 to
0.07 of each view's flush value. But where there is no ledge the free shadow
has nothing to pin it; before the second bound it ran past the moving edge
and read gaps 3 to 4 px short. Under blur, frames with no ledge fit 1.5 to 2
times better with it than without, so no gain threshold tells a real ledge
from blur. Not used to read gaps.

**Carried, it needs the lift.** Free fits on the test poses put the shadow
0.93 to 1.39 px from the moving edge per millimetre of lift (0.95 and 1.15 on
the x sweep at 35/20 and 60/20): a shadow's offset grows with the height of
what casts it. Held at that times each frame's commanded lift, every slid-back
test pose read near its flush value, and the solve got worse: clean x 0.026
-> 0.040 mm, blur three times worse. A shadow placed at a fixed fraction of
the lift also puts a sliver of "ledge" into frames that have none (the y
sweep, the 50-degree views), whose free level soaks up other shading. Not
kept. Even applied only to the frames slid back (an oracle, by the commanded
x) the clean test poses did not improve: at the lift the sweeps were made at,
the hinge had already absorbed the ledge's error.

**Near contact is where a model is worth having.** The hinge is a slope
measured at 4 mm; the ledge's error depends on the lift, and the eight low
test poses (0.6 to 2.5 mm up) are where the twenty-seventh found the side
pair 0.2 to 0.44 px short. With the ledge carried there, x falls from 0.114
to 0.05 mm.

**Where the ledge ends is where the still edge would be at flush.** The lit
ledge is the top face the moving part has slid off, so it ends where the
moving part's footprint is. In the image that is the moving edge less the
gap the pair would have at flush at that lift: the y sweep's gap, a straight
line in the lift (1.04 px per mm at 35/20, 1.23 at 60/20, residuals 0.004 to
0.05 px). Placed there, a frame at flush has no ledge at all and needs no
gate, and a frame slid back has exactly as much as it slid. The free fits'
offsets, 0.95 and 1.15 px per mm, were this less the shadow's half-width.

**The shadow's width must be measured on sharp images.** (Wrong: one bad
fit, see "A thirty-third". With that fit refused, zero does as well under
blur.) Held at zero, the
blurred test poses came out 1 mm off. Fitted in every frame with the offset
held, the clean ones went to 0.12 to 0.15 mm in x. Measured by free fits on
the blurred frames themselves, 1.2 mm. Measured on the clean frames where
the lit ledge is wide (the shadow at least 1.5 px from the still edge and
fitting 1.5 times better than the strip alone), it is 0.008 to 0.18 px per
mm of lift on the side pair and none is found on the front pair's milder
ledge. It is a penumbra, set by the light's size and the lift, a property of
the scene; under a lens's blur the free fit cannot tell it from the blur. A
camera that blurs needs it from somewhere sharper.

So: `npm run ledge` measures both with no truth, the line from a flush y
sweep and the widths from `gap-sweep --ledge-fit` runs on sharp images, and
`gap-sweep --ledge <file>` holds them in every frame of every view-pair,
placed at the frame's commanded lift. Four views, no truth, x / y / z mm and
turn degrees (three renders' RMS for the clean test poses):

| | before, hinged | ledge, hinged | ledge, joint |
|---|---|---|---|
| test poses, three renders | 0.044 / 0.021 / 0.022 / 0.019 | 0.039 / 0.020 / 0.024 / 0.017 | 0.040 / 0.022 / 0.027 / 0.017 |
| low poses, 0.6-2.5 mm up | 0.114 / 0.059 / 0.049 / 0.049 | **0.049** / 0.050 / 0.047 / 0.060 | 0.051 / 0.053 / 0.056 / 0.058 |
| blur 0.8 px | 0.120 / 0.053 / 0.074 / 0.030 | 0.122 / 0.049 / 0.066 / 0.018 | **0.079 / 0.039 / 0.029 / 0.022** |
| blur, ten sets | 0.155 / 0.072 / 0.093 / 0.066 | 0.152 / 0.065 / 0.081 / 0.043 | 0.137 / 0.061 / 0.065 / 0.038 |

(Before, joint: 0.065-0.080 mm in x on the clean renders, 0.133 / 0.043 /
0.070 / 0.037 under blur. The ledge does what the hinge did, and more.)

- **Near contact x halves**, whichever calibration.
- **Under blur, `joint` with the ledge is the best of everything tried**: z
  0.074 -> 0.029 mm. The hinge on top of the ledge fits something else.
- **On clean test poses nothing changes beyond render noise.** The hinge had
  that case.
- **The front pair** is in the table too, with no shadow width. Left out, the
  clean z is 0.020 mm and blur's 0.065; in, 0.027 and 0.029.
- **The commanded lift is an input.** Every lift off by 0.3 mm moves the clean
  test poses to at most 0.036 / 0.046 mm in y and z; off by 1 mm, the turn
  goes to 0.13 degrees. A carried pose knows the lift to about a tenth of a
  millimetre. In a closed loop the render is where the part is and the lift
  is where the robot believes it is: `servo --ledge` passes its prior's
  (`gap-sweep --ledge-lift`).

**In the loop it changes nothing, and should not.** From the twenty-seventh's
two starts, hinged, `--lateral-floor 0`: start A estimated x 0.09 mm off at
1 mm up and ended 0.10 / 0.01 / 0.02 mm and 0.03 degrees off; start B went
from 2.5 mm to contact and ended 0.01 / 0.03 / 0.00 and 0.02 (without the
ledge: 0.04 / 0.01 / 0.04 / 0.01 and 0.05 / 0.00 / 0.02 / 0.00). The loop
aligns x at the hover height before it descends, so near contact the part
is flush and there is no ledge to read; what is left is the robot's last
move and render noise. The ledge matters to a part that is low AND slid
back -- the low test poses -- which a different policy, or an assembly
that slides into place, would meet.

(`notes/brads-notes/2026-10-07-ledge/`.)

#### A thirty-third: the shadow's width under blur was one bad fit

The thirty-second left open that a blurring camera cannot measure the
shadow's width, and said it needs one: held at zero the blurred test poses
came out 1 mm off, and with widths from blur's own free fits 1.2 mm. Both are
**one reading**. At 35/20, pose 3, the side pair with its ledge held and a
width of zero read 11.67 px where the strip alone reads 5.52, fitting 1.003
times better. A shadow with no width is a sharp step, and a sharp step can
pass for the moving edge: the fit put the shadow where the moving edge is and
the "moving edge" out on the moving part's face. Blur's own fits measured
zero width at that view, hence the same reading. Every width from 0.05 px up
to the sharp table's gave the same 1 mm: it is not sensitivity to the width.

The bad fit's levels say what happened: its "lit ledge" is 0.070, the dark
strip's level, and its "strip" 0.234, the moving face's. The roles inverted.
So `trackPair` now keeps a held ledge only if its lit ledge is brighter than
the strip beside it, which is what lit means; every other ledge seen on the
stack was. That refuses the one reading and moves three others by at most
0.09 px. Four views, no truth, `joint`, x / y / z mm and turn degrees:

| blur 0.8 px | four views | ten sets |
|---|---|---|
| widths from sharp images | 0.084 / 0.041 / 0.031 / 0.023 | 0.141 / 0.065 / 0.072 / 0.039 |
| widths zero | 0.085 / 0.044 / 0.030 / 0.023 | 0.145 / 0.067 / 0.071 / 0.038 |
| widths from blur's own free fits | 0.092 / 0.046 / 0.042 / 0.034 | 0.150 / 0.070 / 0.084 / 0.043 |

A limit on how far the ledge may move the moving edge from the plain fit's
was the first guard: a held ledge moved it -0.59 to +0.39 px over 612 stack
readings, so 1 px refused the bad one and nothing else, and gave 0.080 /
0.039 / 0.029 / 0.022 above. It was replaced before merging, because it
depends on the scene. With the ledge lit brighter than the moving face, the
plain fit takes the shadow for the moving edge and reads a 4 px gap as 1.23;
a real ledge then moves the edge by its whole lit width, and the limit
refuses the right answer (`test/pairs.js`). On the stack the ledge (0.175)
is darker than the moving face (0.23), which is why no run met it.

Clean, every run reads as before. **A blurring camera
needs no sharper capture: hold the width at zero** (`npm run ledge` without
`--fits`). Measured under blur the widths come out too wide, about twice the
sharp ones at the 50-degree views, and that costs a little. Scaling the sharp
widths by 0.5 or 2 changed the blurred result by at most 0.01 mm. The blur's
own aperture, measured on lone segments, already carries the softness.

Whether the calibration could pick the width with no truth was tried first,
and it could not: its residual was 0.0387 px at zero width, when the test
poses were 1 mm off, against 0.0375 to 0.0386 at the good widths. One wild
reading in a hundred moves a fit of hundreds of frames very little.

(`notes/brads-notes/2026-10-07-ledge/`: `widths.sh`, `scale.sh`, `shift.js`;
the lit guard `run-la.log`, `lit-*.log`; the shift guard `run-ga.log`,
`guard-*.log`.)

#### A thirty-fourth: a turned pair's strip level

The twenty-ninth left one reading of `stack-2g-large` out: the 8-degree
pose's side pair at 35/50, ambiguous, both hypotheses wrong. It reads 2.98
px in the middle, so gap-sweep holds its strip level at the 0.084 carried
from a parallel frame, though it is open about 6 px at one end; held there,
the strip hypothesis settles 0.8 px short. Its own level is 0.119. Fitting
the level wherever an end was wide brought it back and doubled the turn's
error on the test poses (0.019 -> 0.037 degrees), because every turned
frame then fitted its level.

So the level is fitted only where holding it gives no reading: `trackPair`
held, ambiguous, and open at least `wideEnd` px (3, gap-sweep's `carryMin`)
at one end, tries again with the level fitted and keeps that if it is a
strip. Nothing that reads now can change. Over every stack run (the four
calibration sweeps, the three test renders, the low poses, the large ones)
the one reading changes and no other moves 0.05 px; it reads 1.035 for a
true 1.09. Four views, no truth, hinged, x / y / z mm and turn degrees:

| `stack-2g-large`, twelve poses | four views | ten sets | the 8-degree pose |
|---|---|---|---|
| before | 0.164 / 0.072 / 0.107 / 0.093 | 0.214 / 0.111 / 0.184 / 0.119 | -0.35 / -0.06 / 0.12 / -0.18 |
| level fitted where ambiguous and wide | 0.147 / 0.072 / 0.108 / 0.090 | 0.184 / 0.109 / 0.184 / 0.117 | -0.25 / -0.05 / 0.13 / -0.16 |

No synthetic turned pair tried, 6 to 10 degrees with the level carried in
wrong and noise added, is ambiguous held -- a wrong level reads 0.1 to 0.2
px off instead -- so the tests pin what must not change, and the frame that
needs it is a render's. (The re-reads must score as the run did: `retrack.js`
takes `MAX_ANGLE=12`, which the large poses were analysed with; without it
the 8-degree rows have no truth to match and keep their old reading.)

(`notes/brads-notes/2026-10-07-ledge/`: `one.js`, `retrack.js`.)

#### A thirty-fifth: the moving part below

Everything so far moved the top cube. An assembly may as well move the part
underneath, and the thirty-second said its ledge assumed the moving part was
above. The same scene was rendered with the roles swapped (`gap-sweep
--moving Cube --target Cube2`): the base cube moves, 4 mm below contact,
every sweep and test pose stack-2g's mirrored, so the pictures are the same
physics. Four things assumed the moving part was the upper one, and only
the last was the ledge.

- **The truth's sign.** A gap is positive toward the moving part, judged by
  the part's projected middle. Seen from 50 degrees up, a part BELOW the gap
  has its middle projected above its own near top edge -- its depth carries
  it up the picture further than its half height carries it down -- so every
  gap of the lowered base at 50 degrees was signed as an overhang, and no
  pair there could be carried. The side is now the direction from the still
  part's middle to the moving part's. Recomputed over every analysed run (461,
  8,595 truth gaps), exactly the 192 at the lowered base's 50-degree views
  flip, and nothing else changes (`signs.js`).
- **The solve's axes.** `solve-position` took every sweep's step as a
  displacement along +x, +y or +z, ignoring the sweep's own axis; swept
  along -x, -y, -z the slopes came out mirrored and every pose about 3 mm off.
  A step is now along its sweep's axis (tested end to end on made-up linear
  sweeps, both ways). And `hinged` puts its one-sided slope where the ledge
  is in sight: slid back above, slid out below.
- **Who is in front.** Where the edges cross, the upper part hides the
  lower. `trackPair moving=below` makes the still part the occluder, and
  where the picture is one edge -- an overhang -- that edge is the still
  part's and the moving one is behind it: nothing is read. With the moving
  part above, an overhang is read; below, it cannot be seen.
- **The ledge** is the moving part's own top face, lit against the moving
  edge, in the still part's shadow, which is tied to the still edge. Read as
  one strip, slid out, the side pair reads 0.35 to 0.50 px SHORT -- the shadow
  taken for the moving edge -- where above it read long. `npm run ledge`
  reads a downward flush sweep as such (the flush lines, 0.98 / 1.17 / 0.37
  / 0.62 px per mm on the side pair, are the moving-above table's within
  0.06), and `gap-sweep` writes `moving=below` into every track of a run
  whose moving part is below contact.

The ledge was harder to hold below. The lit ledge is now bounded by the
FREE moving edge, not the carried still one, and two kinds of fit that above
were harmless moved it. With no ledge in sight, a ledge given the moving
face's level carried the moving edge off the end of the band (a front pair
at 60/50, 1.4 px, read 22): a ledge fit whose moving edge is not an aperture
inside the band is refused, which changes nothing above. And near flush,
ledges fitting 1.000 to 1.07 times better than the strip alone moved the
edge 0.3 to 1.8 px the wrong way, their "lit" level the moving face's (0.28
to 0.39 against a real ledge's 0.14 to 0.21); real ones fitted 1.1 to 2.6
times better. Below, a ledge must fit 1.1 times better.

No truth, four views, x / y / z mm and turn degrees:

| moving part below | test, hinged | test, joint | low, joint |
|---|---|---|---|
| no ledge | 0.314 / 0.122 / 0.163 / 0.058 | 0.103 / 0.071 / 0.108 / 0.065 | 0.120 / 0.068 / 0.095 / 0.089 |
| ledge held | 0.151 / 0.061 / 0.079 / 0.036 | **0.102 / 0.045 / 0.055 / 0.030** | 0.101 / 0.063 / 0.085 / 0.082 |

(Above, for comparison, joint with the ledge: 0.027 / 0.021 / 0.028 / 0.019,
low 0.050 / 0.055 / 0.052 / 0.058.) The ledge halves y, z and the turn on the
test poses; x stays at 0.10 mm, four times the moving-above case, and why is
not found. Seven of eight low poses solve: one has too few readings, its
overhangs unseen. A synthetic mirrored ledge 1.5 px wide reads 0.11 to 0.15
px short where the same ledge on the still part reads within 0.05 -- the
held shadow width taken up by the free edge -- which may be part of it.

(`notes/brads-notes/2026-10-07-below/`: `render.sh`, `analyse.sh`,
`solve.sh`, `signs.js`, `solves.log`.)

#### A thirty-sixth: a response curve left in, and undone

The twenty-fourth found a response curve left in costs nothing: gamma 2.2
written where the lab decodes sRGB. That is the gentlest curve there is. A
camera's own processing is not gentle -- a "contrast" setting, a filmic tone
curve -- so `degrade --scurve <k>` applies one: a tanh about mid-grey on the
encoded value, black, mid-grey and white kept, the middle steepened by
k / (2 tanh(k/2)) (1.66 at k = 3, 3.0 at k = 6) and the ends flattened. The
stack-2g sweeps and test poses, degraded, analysed with the pooled still edge
(no ledge) and solved with no truth, four views, x / y / z mm and turn
degrees:

| curve | hinged | joint |
|---|---|---|
| none | 0.026 / 0.019 / 0.023 / 0.019 | 0.065 / 0.024 / 0.026 / 0.021 |
| gamma 2.2 | 0.029 / 0.025 / 0.029 / 0.018 | 0.053 / 0.025 / 0.027 / 0.021 |
| S, k = 3 | 0.236 / 0.103 / 0.181 / 0.022 | 0.105 / 0.039 / 0.047 / 0.035 |
| S, k = 6 | 0.245 / 0.183 / 0.200 / 0.030 | 0.134 / 0.119 / 0.129 / 0.048 |
| S, k = 3, undone | 0.026 / 0.020 / 0.024 / 0.019 | 0.063 / 0.023 / 0.024 / 0.019 |
| S, k = 6, undone | 0.029 / 0.025 / 0.026 / 0.016 | 0.060 / 0.028 / 0.030 / 0.018 |

- **A contrast curve is not free**: four to nine times the error, the hinged
  calibration worst. The fit's levels are its own, but a step's shape is
  not: the curve bends each edge's ramp, by more on one side than the
  other, and the edge moves. A gamma bends little enough not to matter.
- **Undone, it is free again.** Each 8-bit value through the exact inverse,
  written back as 8 bits -- what `load` would do knowing the curve -- gives
  back the clean result, k = 6 within 0.003 mm in x though one 8-bit step at
  its flattened ends spans twenty of the original's.

So the open item is real for a camera that applies a curve, and undoing it
on load is the whole fix. What is not built is the load option and a way to
measure a camera's curve; the second wants exposure brackets, which a render
can supply with a known curve to check against, and a real camera only to
confirm.

(`notes/brads-notes/2026-10-07-scurve/`: `run.sh`, `invert.js`, `undo.sh`.)

(Corrected by the thirty-seventh: most of the four to nine times is the lit
faces pressed into the curve's flat top, not the curve. One stop under, the
k = 6 curve left in costs 1.5 times.)

#### A thirty-seventh: a camera's curve, measured and undone on load

The thirty-sixth left two things unbuilt, and both are now:
`load(..., curve="<file>")` (and `lab-cli --curve`, `gap-sweep --curve`)
takes a table of the linear light each 8-bit code stands for, in place of
`from`, straight into f32; `npm run response` measures that table from an
exposure bracket -- the same still scene at three or more known exposures --
by Debevec and Malik's least squares on log light, each pixel's own light
eliminated so the system is 256 x 256. `degrade --exposure` makes a bracket
from a render, so the true curve is known: five shots, 0.25 to 4, of one
frame of the stack-2g test poses.

The load path first, with the exact inverse written as a curve file: k = 3
and k = 6 give 0.026 and 0.030 mm in x (hinged, four views), what the 8-bit
rewrite of the thirty-sixth gave. Then the measured curves, the same runs and
solves, x / y / z mm and turn degrees:

| curve undone with | hinged | joint |
|---|---|---|
| S k = 3, left in | 0.236 / 0.103 / 0.181 / 0.022 | 0.105 / 0.039 / 0.047 / 0.035 |
| S k = 3, measured | 0.026 / 0.019 / 0.024 / 0.020 | 0.069 / 0.026 / 0.029 / 0.021 |
| S k = 6, left in | 0.245 / 0.183 / 0.200 / 0.030 | 0.134 / 0.119 / 0.129 / 0.048 |
| S k = 6, exact | 0.030 / 0.024 / 0.026 / 0.017 | 0.062 / 0.028 / 0.029 / 0.019 |
| S k = 6, measured | 0.234 / 0.110 / 0.191 / 0.026 | 0.120 / 0.042 / 0.057 / 0.031 |
| S k = 6, measured, code 255 set to the truth | 0.031 / 0.025 / 0.024 / 0.018 | 0.060 / 0.027 / 0.027 / 0.020 |
| *one stop under (exposure 0.5)* | | |
| no curve | 0.026 / 0.021 / 0.023 / 0.019 | 0.063 / 0.024 / 0.029 / 0.021 |
| S k = 6, left in | 0.038 / 0.029 / 0.033 / 0.013 | 0.034 / 0.026 / 0.039 / 0.013 |
| S k = 6, measured | 0.024 / 0.020 / 0.024 / 0.019 | 0.062 / 0.026 / 0.024 / 0.020 |

(The measured curves here are from noise-free brackets, `--smooth 10`.)

- **A measured curve does the whole job wherever nothing clips.** Over
  codes 1 to 254 it is within 0.1% of the truth, and k = 3, or k = 6 one
  stop under, come out as the clean renders do.
- **Code 255 cannot be measured, and at k = 6 it is everything.** The
  stack's lit faces sit in the curve's flattened top: 0.9% of all pixels at
  255, 4.2% at 250 or above. Light that reached 255 in every shot is known
  only to be at least so much; the fit extrapolates it 7 to 14% low, and that
  one value moved every tracked gap 0.06 px and x by 0.2 mm. Set to the
  truth, the rest of the measured curve gives the exact result. So the
  remedy is the camera's: **expose so that what is measured stays below
  255.** One stop under, nothing reaches it and nothing is lost.
- **That also corrects the thirty-sixth.** Its four to nine times was mostly
  the shoulder: one stop under, the k = 6 curve left in costs 1.5 times
  (0.038 against 0.026), and nothing undone.
- **Three things that were tried and did not help.** Pinning code 0 to black
  was suspected of the k = 6 shortfall, wrongly: the readings did not move
  (it is kept, because a response curve's foot is at zero light). Sampling
  more pixels does not reduce the curve's error, and weighting the codes
  evenly instead of by Debevec's hat does not fix the top: neither reaches
  code 255. Smoothing does help: `--smooth` 1 left a 1% ripple with a period
  of about fifty codes, quantization showing through, and 10 takes it to
  0.1%; 10 is the default.
- **Noise biases a measured curve.** From a bracket with shot noise (gain
  2000) the curve is 0.7 to 1% off and no smoothing removes it: an 8-bit
  code averaged over noise is not the curve at the average light. At
  exposure 1 that is lost under the clipping (k = 6: 0.249 mm, left in
  0.241, noise alone 0.058). One stop under, with the same noise in the
  images as in the bracket -- the case a camera presents -- it costs little:

  | one stop under, shot noise | hinged | joint |
  |---|---|---|
  | no curve | 0.025 / 0.025 / 0.026 / 0.021 | 0.062 / 0.028 / 0.028 / 0.017 |
  | S k = 6, left in | 0.095 / 0.046 / 0.043 / 0.017 | 0.034 / 0.026 / 0.034 / 0.015 |
  | S k = 6, measured from the noisy bracket | 0.031 / 0.024 / 0.026 / 0.020 | 0.058 / 0.028 / 0.028 / 0.018 |

(`notes/brads-notes/2026-10-07-curve/`: `bracket.sh`, `measured.sh`,
`exact.js`, `compare.js`, `noisy.sh`, `stop.sh`, `stopnoisy.sh`, and their
logs.)

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
