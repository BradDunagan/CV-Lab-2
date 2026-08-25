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
| `support` | how many segment pairs agree at this location — the best single indicator |
| `reach` | how far past its own end each line had to be extended. Negative means they genuinely cross |
| `sigma` | propagated positional uncertainty, in pixels |

`sigma` comes from the fits rather than from a guessed weighting. A TLS fit
over *n* pixels of length *L* with RMS residual *s* has angular slop of about
`s·√12 / (L·√n)`; extrapolating a distance *d* smears the endpoint by `d·δθ`;
and two lines crossing at angle θ combine as `√(e₁²+e₂²)/|sin θ|`. Which is why
`fit` reports `rms` as well as the maximum `residual` — the maximum is a
guarantee about the worst pixel, the RMS is what propagation needs.

**`sigma` measures precision, not correctness**, and that is the thing most
likely to be misread. On the cube, all fourteen candidates located to better
than one pixel — including nonsense at 92 px of reach. Two long, clean,
well-determined lines extended a long way still intersect *precisely*; they
simply intersect somewhere that is not a corner. `reach` and `support` separate
real from invented; `sigma` says how well-located an answer is once you already
believe it.

On the cube this reads out the geometry: four corners with three agreeing pairs
each — a cube in general position has exactly four vertices where three visible
edges meet — plus two more with a reach of 1.1 and 1.4 px, which are the
silhouette vertices where only two edges meet. The other eight all reach 46–92
px.

The expensive follow-up this enables — going back to the image to check whether
gradient magnitude is elevated along an extrapolated path, or re-running
`segments` locally with a lower threshold near a predicted corner — belongs in
a separate operation that consumes corners, so that it runs only where a
hypothesis already exists.

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

**3. Compile with `-ffp-contract=off` if cross-platform bit-exactness is
wanted.** `a*b + c` may fuse into a single FMA instruction with one rounding on
arm64 and compile to two roundings on x86-64. Without this flag, identical
source produces subtly different results on the development Mac and on a
Windows x86 machine — which is exactly the comparison this project invites,
given it ships on three platforms.

The cost is a small performance loss. Given that this is a learning lab where
results will be compared across machines, that is worth paying — and it is far
cheaper than diagnosing a mysterious cross-platform discrepancy later.

**4. Where two routes reach the same value, make them agree on purpose.**
Found by a test, not by reasoning: `load(as=linear)` and
`toLinear(load(...))` differed by one `f32` ULP on about half the possible byte
values, because one route narrows an intermediate to `f32` and the other stays
in `double`. Numerically that is nothing. For a lab that compares content
hashes it is the difference between two provenance chains agreeing and not, so
the lookup table now narrows to `f32` before applying the transfer function,
deliberately. Expect more of these wherever a value can be computed two ways.

**What remains achievable:** bit-exact results within a machine, and — with
rule 3 — across platforms. What is not achievable is bit-exactness across
different compiler versions or optimisation levels; treat those as new
provenance, and record the addon build identity alongside operation versions.

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
| Colormap | gray · viridis · turbo · diverging · categorical |
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

  An embedded ICC profile is reported, not interpreted — saying "there is a
  profile" is honest; guessing at its transfer curve would not be. PNG only:
  JPEG carries this in EXIF/ICC and WebP in its own chunks, and both fall back
  to the convention.
