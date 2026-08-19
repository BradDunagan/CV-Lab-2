# cv-lab-2: The Lab Model

How the application is organised from the user's point of view, and the data
model underneath it.

Unlike `electron-guide.md`, which records things learned by doing them, this
document is written **before** the work. Treat its claims as decisions, not
findings — and correct it when reality disagrees.

**Two requirements drive almost everything here:** the lab must handle
**non-8-bit data**, and results must be **reproducible**. Several choices below
would be different if either were relaxed.

---

## 1. The core model

Three concepts. Keeping them separate is the central decision of the design.

| Concept | What it is | Named |
|---|---|---|
| **Buffer** | Raw pixel data: `width, height, channels, dtype`, plus the bytes | — |
| **Slot** | A named container holding one buffer, plus its provenance | `A`, `B`, `edges`, … |
| **View** | A tile displaying one slot, with a non-destructive display transform | — |

All slots are identical in kind. There is no "input canvas" and no "result
canvas" — any slot can hold any image, and operations read and write them
interchangeably. Slots are created by the user (or implicitly, on assignment),
so there is no fixed number to get right.

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
    { name: 'axis', type: 'enum', values: ['x', 'y', 'mag'], default: 'mag' },
  ],
  output: { channels: 1, dtype: 'f32' },
  cancellable: true,
}
```

The registry is the single source of truth for:

- the operation dropdowns and their parameter forms
- validation in the command parser, and its error messages
- generated documentation
- what gets recorded in the provenance log

Adding a kernel is one registry entry plus one C function — not edits scattered
across four files.

**`version` matters because reproducibility does.** When a kernel's behaviour
changes, bump it. Old session logs then record which version produced them,
and a replay that produces different pixels has an explanation rather than a
mystery.

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

### Provenance

Each slot records the command that produced it, the slot versions consumed, the
operation versions used, and a **content hash of the resulting buffer**.

```
#1  A ← load("samples/board.png")     sha256:9f2c…  4243×2829×1 f32
#2  B ← gaussian(A#1, sigma=1.4)      sha256:31ab…  4243×2829×1 f32
#3  C ← sobel(B#2, axis=mag)          sha256:c740…  4243×2829×1 f32
```

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

The architecture already validated in the skeleton — addon in the renderer
process, preload owning the pixels — is exactly what this needs.

---

## 9. Decide now vs. defer

Expensive to retrofit, so settle them first:

- `f32` working format and the 0–1 intensity convention
- deterministic reductions, `-ffp-contract=off`, no `-ffast-math`
- a cancellation flag in every kernel signature
- the operation registry as the single source of truth
- an optional ROI rectangle in the operation signature, even if it is always
  "whole image" for now
- content hashing of buffers

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
- **Colour handling.** Is there a linear-vs-sRGB distinction to track per
  buffer? Filtering in sRGB is technically wrong, and it matters more for some
  operations than others.
- **Where `load` decodes.** Chromium's decoder is excellent and free, but it
  returns 8-bit RGBA — so anything higher-precision (16-bit PNG, TIFF, raw)
  needs a native decode path, and that means a third-party library and all the
  build complexity `electron-guide.md` §5 describes avoiding.
