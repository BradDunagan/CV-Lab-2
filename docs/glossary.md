# Glossary

Terms used in `design-lab-model.md` and `electron-guide.md`, explained from
scratch. The prose in those documents deliberately uses the words practitioners
use — this is the lookup table, not a replacement for them.

Alphabetical. Grows on request; if a term is missing, it belongs here.

Section references always name their document — both documents number their
sections from 1, so a bare "§6" would be ambiguous.

---

## ABI — application binary interface

**The contract between two pieces of *compiled* code, as opposed to an API,
which is the contract between two pieces of *source* code.**

An **API** is what you write against: function names, argument types, what
`sobel(src, axis)` means. The compiler checks it.

An **ABI** is what those functions look like once compiled to machine code:

- which CPU registers arguments arrive in, and which go on the stack
- how a struct is laid out in memory, including invisible padding between fields
- what symbol names look like in the binary
- who cleans up the stack afterwards
- how objects are arranged in memory

Two programs can agree perfectly on the API and still be unable to talk, because
they disagree on the ABI.

**Why it matters here.** Your compiled `.node` calls functions inside the host
executable (`node` or `electron`). If the host's internal structures change
shape, the addon's compiled-in assumptions become wrong — and the failure is a
crash, not an error message. Node guards against this with a
`NODE_MODULE_VERSION` check that refuses to load a mismatched addon.

**Node-API's whole promise is a *stable* ABI.** The `napi_*` functions are plain
C with fixed signatures, and JavaScript values are hidden behind opaque handles,
so the addon never depends on V8's internal memory layout. That is why one
binary works under both Node 24 and Electron 43 — verified in this project,
not assumed.

**An analogy:** the API says "the recipe needs two eggs." The ABI says "the eggs
arrive in this exact box, in this order, at this address, and you must put the
box back afterwards."

**Elsewhere**: C++ ABI breaks between compiler versions and standard libraries;
glibc symbol versioning; Rust deliberately has *no* stable ABI, which is why
Rust libraries expose C interfaces when they need to be called from elsewhere.

---

## AOV — arbitrary output variable

**A rendering pass that outputs something other than the picture: depth,
surface normals, base colour, object identity, motion.**

The term comes from production rendering — RenderMan's, then everyone's — where
a frame is delivered not as one image but as a stack of them, so that a
compositor can relight, re-fog or re-grade without re-rendering. Also called a
*render pass* or, when the values describe surfaces rather than light, a
*G-buffer* (geometry buffer), which is the same idea arrived at from real-time
rendering.

**Why they matter here.** They are how a renderer answers a question the
picture cannot. Given only the beauty render, "is this edge real geometry?" has
no answer; given the depth pass, it does.

The three this project asks pt-lab for, and what each one settles:

| Pass | Holds | Answers |
|---|---|---|
| **depth** | distance from the camera, per pixel | is there a step here — one surface ending in front of another? |
| **normal** | which way the surface faces | is there a fold here, with no step? |
| **albedo** | base colour, unlit | is this just paint? |

Together they decompose *why* an edge is in a picture. A depth step is an
**occlusion**; a normal step with no depth step is a **crease**; an albedo step
with neither is texture; and an edge with none of the three is shading — a
shadow boundary or a specular terminator, which is a real image edge belonging
to the light rather than to the object.

**They are not colour, and that is a trap.** These passes carry raw linear code
values — metres, packed vector components, unlit reflectance — so pt-lab writes
them as PNGs with **no colour chunks at all**, deliberately, because an sRGB tag
would invite a decoder to apply a transfer curve that was never there. Reading
one requires saying `from=linear`; under this project's sRGB-by-convention
default the numbers come back silently and nonlinearly wrong. See
`design-lab-model.md` §11.

**Precision costs.** An 8-bit channel is nowhere near enough for depth, so
pt-lab packs a 24-bit fixed-point value across R, G and B — which is why a depth
pass looks like a rainbow of fine stripes rather than a smooth ramp, and why it
carries a `maxDepth` scale factor alongside it. Decode with
`depth = (R + G/255 + B/65025) / 255 × maxDepth`.

**Elsewhere**: Blender's render passes, Arnold and V-Ray AOVs, the G-buffer in
any deferred renderer, and the auxiliary inputs an ML denoiser takes — OIDN
wants albedo and normal for exactly the reason above, because they show it where
the real boundaries are when the colour input is still noise.

---

## ASAR — Atom Shell Archive

**Electron's app bundle: one file containing all of your application's files
concatenated together, with an index at the front.**

The format is deliberately simple — a JSON header listing every file with its
byte offset and length, followed by all the file contents end to end. **No
compression.** Named after Atom Shell, which is what Electron was called before
it was called Electron.

**Why it exists:** not to save space, but to reduce *file count*. Resolving
`require()` across a deep `node_modules` tree costs thousands of filesystem
calls; one open file and some offset arithmetic is far faster. It also sidesteps
Windows' 260-character path limit.

Electron patches Node's `fs` module so paths resolve into the archive
transparently — `require('./src/main.js')` just works.

**The trap:** that transparency stops at `dlopen`/`LoadLibrary`, which are
operating-system calls that know nothing about ASAR. A `.node` inside the
archive cannot be loaded, which is why `asarUnpack` exists.

**Not security.** `npx asar extract app.asar out/` recovers everything in
seconds. Never put secrets in one.

**Elsewhere**: conceptually an uncompressed `tar`, or a `zip` with compression
turned off. Similar in spirit to Java's `.jar` and Python's `.whl`.

---

## CDP — Chrome DevTools Protocol

**The wire protocol Chrome DevTools itself speaks to a browser: a JSON-RPC
conversation over a WebSocket, one connection per *web contents*.**

Opening DevTools does not give the browser a special debugging mode. DevTools is
an ordinary web page that connects over this protocol and issues commands. Once
the port is open, anything that can speak WebSocket can issue the same commands
— which is what makes an Electron app scriptable from the outside without
building a test hook into the app.

**Getting a connection.** Launch with `--remote-debugging-port=9222`, then
`GET http://127.0.0.1:9222/json/list` returns one entry per debuggable target,
each with a `webSocketDebuggerUrl`. An Electron app has more than one: the
renderer, plus any `WebContentsView` — the generator's `gen://lab/index.html`
appears there only while a sweep is running.

**The commands that do most of the work:**

| | |
|---|---|
| `Runtime.evaluate` | run an expression in the page and get the result back |
| `Page.captureScreenshot` | a PNG of that target |
| `Input.dispatchMouseEvent` | a mouse event entering at the top, like a real one |
| `Input.dispatchKeyEvent`, `Input.insertText` | typing |

**Why it matters here.** `scripts/smoke-package.js` uses it for the job nothing
else could do: launch the *packaged artifact* and ask whether it actually works
— see `electron-guide.md`, and the note that layout is not behaviour. It frames
its own WebSocket rather than adding a dependency for one test.

**A CDP input event is not a synthetic DOM event, and the difference is the
point.** `element.click()` runs the handler directly; a dispatched mouse event
goes through real hit-testing, so it can land on something the element did not
expect to be under the pointer. That is how the paneless hover-overlay defect
was found — a control that looked present and was unreachable, because a
transparent header overlay took the click. A synthetic click would have
reported success.

**Two limits worth knowing before trusting a result:**

- **`Page.captureScreenshot` captures one web contents, not the composited
  window.** A child `WebContentsView` does not appear in it — the pane it
  occupies photographs blank. Connect to that view's own target instead.
- **It reaches renderers, not the main process.** Main is plain Node, debugged
  through `--inspect` on a separate port, which is a different protocol that
  happens to look similar. Menu accelerators are handled in main, so injected
  key events do not fire them.

**Elsewhere**: Puppeteer and Playwright are CDP clients with an ergonomic API
over the top; `chrome://inspect` is a CDP client; the WebDriver BiDi standard is
an attempt to give every browser an equivalent.

---

## Color handling — linear vs sRGB

Background reading: [sRGB on Wikipedia](https://en.wikipedia.org/wiki/SRGB).

**A pixel value stored in an image file is not proportional to the amount of
light it represents.** Knowing which of the two a buffer holds is the whole of
this topic.

| | What the number means |
|---|---|
| **linear** | proportional to light. Double the number, double the photons. |
| **sRGB** (gamma-encoded) | proportional to *perceived brightness*. Double the number is roughly double the apparent lightness, which is far more than double the light. |

Files — PNG, JPEG, what a camera writes, what a browser hands you — are almost
always **sRGB-encoded**.

### Why encoding exists at all

Two reasons, one historical and one still valid.

**History:** CRT monitors turned voltage into light along a power curve of about
2.2. Encoding images with roughly the inverse curve meant the display undid the
encoding for free.

**Still true:** human vision discriminates far more finely in dark tones than in
bright ones. Spending 8 bits linearly wastes codes on highlights nobody can
distinguish and starves the shadows, producing visible banding. sRGB encoding
spreads the 256 available codes to match perception, which is what makes 8-bit
images look acceptable at all.

The actual sRGB transfer function is a power curve with a small linear segment
near black:

```
sRGB → linear:   L = S/12.92                        if S ≤ 0.04045
                 L = ((S + 0.055)/1.055) ^ 2.4      otherwise

linear → sRGB:   S = 12.92 · L                      if L ≤ 0.0031308
                 S = 1.055 · L^(1/2.4) − 0.055      otherwise
```

Approximating it as `^2.2` and `^(1/2.2)` is common and close enough for many
purposes, but not exact.

### Why "filtering in sRGB is technically wrong"

Blurring, resizing and blending are **physical** operations — they model light
mixing, and light adds linearly. Averaging encoded values averages in the wrong
space.

Average black and white:

| Done in | Result | Appears as |
|---|---|---|
| linear (correct) | `(0.0 + 1.0)/2 = 0.5` light | ≈ **188**/255 when encoded back |
| sRGB directly | `(0 + 255)/2 = 128` | ≈ 0.216 light — **much too dark** |

This is why naively downscaled images come out darker than the original, why
thin bright lines vanish when resizing, and why gamma-incorrect blurs grow dark
halos.

### Where it matters, and where it genuinely does not

**Needs linear** — anything that mixes pixels or models light:

- blur, and any convolution with positive weights summing to 1
- resize and downsample
- alpha blending and compositing
- means and averages of intensity
- physically-motivated work: HDR merge, deconvolution, photometric stereo

**Unaffected** — anything depending only on the *order* of values, because the
transfer function is monotonic:

- threshold (a threshold in sRGB is simply a different threshold in linear)
- median and other rank filters — the median of encoded values *is* the encoded
  median
- sorting, connected components, morphology on binary data

**Different, but not wrong** — gradients and edge detection. The encoding
redistributes contrast, so a Sobel run on sRGB values emphasises edges in dark
regions more than the same operator on linear values. Much of classical computer
vision runs happily on gamma-encoded images; Canny and SIFT are normally applied
to them. The result is not incorrect, it is a different measurement — which is
exactly why a lab should know which one it made.

### The trap in a grayscale conversion

The familiar coefficients apply to **linear** values:

```
Y = 0.2126·R + 0.7152·G + 0.0722·B     ← luminance, only valid on linear values
```

Applying those same weights directly to sRGB-encoded values produces **luma**
(written `Y'`), which is a different quantity. Most code does this without
noticing. It is the first place the distinction will bite this project, since
`gray` is in the first slice of operations in `design-lab-model.md` §10.

### Two coherent policies

Either works; mixing them silently does not.

1. **Convert to linear on load, work entirely in linear, convert back for
   display.** Physically correct everywhere by default. In an 8-bit tool this
   would cause banding — but this project works in `f32`, so the usual objection
   costs nothing.
2. **Keep values as loaded and track a per-buffer flag**, with operations
   declaring which space they need and the runtime converting or refusing.
   More bookkeeping, but results stay comparable with other CV tools, which
   mostly operate on gamma-encoded values.

Whichever is chosen, the space belongs in the buffer's metadata and in
provenance — "which space was this computed in" is exactly the sort of question
a reproducible log should answer.

### One more distinction

"sRGB" the standard specifies **two separate things**: the transfer function
above, *and* a gamut — which physical colors the R, G and B primaries actually
are, plus a D65 white point. "Linear" here means linear **sRGB**: the same
primaries, without the curve. Wider-gamut spaces such as Display P3, Adobe RGB
and Rec.2020 change the primaries as well, which is a separate problem from
the one above.

---

## Colormap

**A rule for turning one number into one colour, so that single-channel data can
be looked at.**

A slot in this project holds *numbers*, not colours — one `f32` per pixel. A
screen needs red, green and blue. The colormap is the function bridging the two.
Also called a *lookup table (LUT)* or *palette*.

Colormap and **range** are separate settings that work together: the range
decides which data values land at the two ends of the scale, the colormap
decides what colours those ends and everything between actually are.

### The three families

Choosing the right *family* matters far more than choosing between names within
one.

| Family | Use when | Options here |
|---|---|---|
| **Sequential** | data runs low → high with no special middle | `gray`, `viridis`, `turbo` |
| **Diverging** | a midpoint is meaningful, and deviation either side matters | `diverging` |
| **Categorical** | values are labels, not quantities | `categorical` |

### The individual options

**`gray`** — black at the low end, white at the high end.

Honest and familiar: it adds no colour that was not in the data, and matches how
a photographic intensity image is expected to look. Its weakness is that the eye
distinguishes far fewer levels of grey than of colour, so subtle structure
hides.

**`viridis`** — dark blue → green → yellow.

Designed for matplotlib in 2015 to replace the old rainbow default, and built
to three properties worth knowing because they are what "good colormap" means:

- **perceptually uniform** — equal steps in the data look like equal steps in
  colour. A map without this invents visual edges where the data is smooth, and
  flattens real structure elsewhere.
- **monotonic in lightness** — it also reads correctly printed in greyscale.
- **colourblind-safe** — legible with red-green colour vision deficiency, which
  affects roughly 8% of men.

The reasonable default when you want more discrimination than grey gives.

**`turbo`** — dark blue → cyan → green → yellow → red.

Google's 2019 rainbow map. It uses much more of the colour space than viridis,
so it shows *fine detail* better — small differences become clearly different
hues. The trade-off is that it is **not** monotonic in lightness, so it is poor
for judging magnitude by eye, and it collapses when printed in greyscale.

Good for depth maps and flow fields, where seeing structure matters more than
reading values. Use deliberately, not as a default.

> **`jet`**, the old MATLAB rainbow, is the cautionary tale behind both of
> these. It is perceptually non-uniform: it manufactures bright bands where data
> is smooth and hides real transitions, and its red-green range is exactly the
> part colourblind readers cannot separate. Turbo is jet done properly.

**`diverging`** — a family rather than one map: two hues meeting at a neutral
midpoint, such as blue → white → red.

Use it when a particular value is meaningful and deviation in both directions
matters. **It must be centred on that value** — pair it with the "symmetric
about zero" range setting — or it lies about the data.

This is why `design-lab-model.md` §6 makes it the default for gradients: a Sobel
result is signed, and
a diverging map shows negative one colour, positive the other, and zero as
neutral. Under `gray` the same data is an undifferentiated smear.

**`categorical`** — a set of visually distinct colours in no particular order.

For data where the number is a *name*, not a quantity: in a connected-components
label map, region 7 is not "more" than region 3, it is simply a different
region. A sequential map would imply an ordering that does not exist.

Two rules come with it:

- **never interpolate** — sample nearest-neighbour, or zooming invents
  in-between colours standing for labels that do not exist
- **expect to cycle** — there are usually more labels than palette entries, so
  colours repeat by modulo. Ideally neighbouring regions get different ones.

**Elsewhere**: matplotlib, MATLAB, ParaView, QGIS and every scientific plotting
tool ship the same families under the same names; the viridis-versus-jet
argument is a well-travelled one worth reading about once.

---

## Content hash

**A short fixed-size fingerprint computed from data, where the same bytes always
produce the same fingerprint and different bytes essentially never do.**

SHA-256 produces 32 bytes whether you feed it 4 bytes or 4 gigabytes.

Properties that make it useful:

- **Deterministic** — same input, same output, always, on any machine.
- **Fixed size** — comparing two 48 MB buffers becomes comparing two 32-byte
  values.
- **Avalanche** — flip one bit of input and the entire hash changes. There is no
  such thing as "nearly the same hash."
- **Collision-resistant** — two different inputs sharing a hash must exist
  mathematically (there are more possible inputs than hashes), but for SHA-256
  nobody can find such a pair.

**Why it matters here.** It converts "reproducible" from an aspiration into
something you can *check*. Replay a session, compare hashes: identical means
byte-identical output, and a mismatch means something changed — a kernel, a
compiler flag, a default parameter.

**Elsewhere**: git names every object by its content hash; `package-lock.json`
records an `integrity` hash per package; the ASAR header carries one per file
(visible in the check run in `electron-guide.md`); IPFS and BitTorrent address
content by hash rather than by location.

---

## Curve (display)

**How values are distributed *across* the display range before the colormap is
applied.**

The **range** decides where the two ends are. The **curve** decides how the
values in between are spread out. Both are display-only: the buffer keeps its
real numbers, and the next operation in a pipeline sees those, not what you were
looking at.

| Curve | What it does | Reach for it when |
|---|---|---|
| **linear** | value maps proportionally to position on the scale | the honest default |
| **log** | compresses large values, expands small ones | data spans orders of magnitude |
| **abs** | absolute value first, discarding sign | you want edge *strength* and not direction |
| **sqrt** | milder compression than log | log flattens too much |

**Why `log` exists.** An FFT magnitude image is the standard case: the centre
term can be thousands of times larger than everything else, so a linear curve
shows one bright dot on black. A log curve pulls the faint structure up into
visibility. Note that `log(0)` is undefined, so implementations use `log(1 + x)`
or add a small epsilon.

**Why `abs` exists.** A signed gradient carries direction in its sign. If you
only care how strong an edge is, `abs` folds negatives onto positives and lets
you use a sequential colormap instead of a diverging one.

`sqrt` is roughly a gamma of 0.5 — usually a gentler version of the same idea
as log.

**"Usually" is doing work there.** The ordering *linear < sqrt < log* only
holds once the data spans orders of magnitude. On a narrow range such as
0–1, `log1p` is very nearly linear, so `sqrt` actually lifts small values
*more* than `log` does. Measured, and pinned down by a test in
`test/render.js`, because the opposite is the natural assumption.

**The thing to stay aware of:** a curve changes *perception*, not data. Anything
you judge by eye after applying a log curve is a statement about the curve as
much as about the image. The numbers underneath are unchanged.

---

## CVE — Common Vulnerabilities and Exposures

**A public catalogue of known security flaws, in which each flaw is given a
unique permanent identifier.**

```
CVE-2023-4863
    │    │
    │    └── sequence number, assigned in that year
    └─────── the year the identifier was assigned
```

**Why it exists:** before it, every vendor, researcher and antivirus company had
their own name for the same bug, and nobody could tell whether two reports were
the same problem. A CVE identifier is a shared, stable name so that a patch
note, an advisory, and a scanner can all refer to the same thing unambiguously.

Run by MITRE, with **CNAs** (CVE Numbering Authorities) — organisations such as
Apple, Google, Microsoft and GitHub, authorised to assign identifiers for flaws
in their own products.

**A CVE is an identifier, not a severity.** It says "this flaw exists and is
catalogued." Severity is a separate thing:

| Term | What it is |
|---|---|
| **CVE** | the identifier and catalogue entry |
| **CVSS** | Common Vulnerability Scoring System — a 0.0–10.0 severity score |
| **NVD** | the US National Vulnerability Database, which enriches CVE entries with CVSS scores and affected-version data |
| **advisory** | a vendor's own writeup, often citing one or more CVEs |

Having a CVE does not mean a flaw is being exploited, nor that you are
affected — that depends on version, configuration, and whether you use the
vulnerable code path at all.

**Why it matters here.** Two ways, both practical rather than theoretical:

- `electron-guide.md` §1 notes that `nodeIntegration` was "the source of a long
  run of CVEs." Those are catalogued instances of the same pattern: enabling
  Node in the renderer turned an ordinary cross-site-scripting bug into remote
  code execution on the user's machine. The count is why the default flipped.
- Once you distribute to other people, **someone else's CVEs become your
  problem.** Chromium has a steady stream of them, and the fixes reach you only
  through an Electron release — which is precisely why Electron supports only
  the latest three majors, and why staying current is not optional
  (`electron-guide.md` §5, Tier 2).

**Where you will meet them**: `npm audit` output, GitHub Dependabot alerts,
Electron and Chromium release notes, and any security questionnaire a
customer ever sends you.

---

## DAG — directed acyclic graph

**A set of things connected by one-way arrows, with no way to follow the arrows
in a circle.**

Taken a word at a time:

- **graph** — nodes (things) joined by edges (connections). Nothing to do with
  charts or plotting.
- **directed** — each edge has a direction. `A → B` is not the same as `B → A`.
- **acyclic** — no cycles. Start anywhere, follow arrows as long as you like,
  and you can never arrive back where you began.

**Why the shape matters here.** Provenance forms a DAG. Each log entry points
back at the entries that produced its inputs, so the arrow means *"was produced
from"*. It is acyclic because a result cannot be its own ancestor — time runs
one way.

It is a DAG rather than a **tree** because a node may have several parents, and
one node may be reached by more than one route. In `design-lab-model.md` §5's
example:

```
#1 A ──► #2 B ──► #3 C ──► #4 D ──┐
   │                              ├──► #5 E
   └──────────────────────────────┘
```

`E` depends on `A#1` twice over — directly, and through the `B → C → D` chain.
A tree would require exactly one path to each node; here there are two. That is
the whole difference.

**Why "acyclic" is worth guaranteeing.** Because the graph has no cycles, you
can always find a valid order to evaluate things in (a *topological sort*), and
walking the ancestry always terminates. A cycle would mean a result that
depends on itself, which is both meaningless and an infinite loop.

**Other DAGs you have met**: git history (commits point at parents), build
dependencies in `make`, spreadsheet formula dependencies.

---

## endpointGap

**How far apart two edges actually *stopped*, measured between their nearest
ends — not between their fitted lines.**

Reported by `corners` on every candidate, and it is the field that decides
whether a corner is real.

The problem it solves: real edges systematically stop short of the corners
they belong to. Blur rounds the vertex so the gradient direction rotates and
region growing halts; [non-maximum suppression](#nms--non-maximum-suppression)
deletes junction pixels outright — 21% of a rendered cube's edge pixels had
four neighbours; and weak ends fall below `minMag`. A gap between a segment's
end and the true corner is therefore the *normal* case, which is why `corners`
reports evidence rather than making the call itself.

**Not the same as `reach`, and the difference matters.** `reach` measures how
far a line had to be *extended* to arrive at the intersection. Two unrelated
lines can each be extended a long way and still meet somewhere perfectly
precise and entirely meaningless. `endpointGap` asks whether the two edges
*ended up near each other*, which is what "they meet here" physically means. A
corner eroded by blur leaves both edges terminating a few pixels short of it,
so their ends stay close even when the extrapolation is long.

Measured on one synthetic cube — fourteen candidates, seven of them real:

| | `endpointGap` | `reach` |
|---|---|---|
| the seven real corners | **1.3 – 3.5** | 1.1 – 33.2 |
| the seven spurious ones | **49.2 – 65.4** | 46.4 – 92.1 |

On that image it separates them with a 14× margin and no overlap. `reach` does
not: two genuine three-way vertices reach 33.2 and 22.2 px, inside the spurious
range, because a corner can lie well past the far end of one of the edges
meeting there. An earlier draft of the design doc named `reach` as the
discriminator and was wrong.

**The clean separation was a property of that image.** Scored against
[ground truth](#ground-truth) over twenty-four views, `endpointGap` is still
the best single field and the ranges overlap: real corners run to 18 px at the
99th percentile, invented ones start below 1 px, and the best threshold — 3.9
px — keeps 92% of the real ones at 71% precision. Paired with `sigma`, which
`design-lab-model.md` had explicitly ruled out as a discriminator, it reaches
94% precision at 84% recall. The two ask genuinely different questions: this
one whether the edges *stopped* near each other, `sigma` whether either fit was
determined well enough to extrapolate at all.

---

## Ground truth

**What is actually there, known independently of whatever your method
reported.**

Borrowed from remote sensing, where it is literal: a satellite says a field is
wheat, and somebody walks out to the field and looks. Everywhere else it keeps
the same shape — a reference answer obtained by some route the system under test
had no access to, against which that system's output is scored.

**Why a renderer can supply it and a photograph cannot.** A photograph of a cube
does not come with a list of where its edges are; producing one means a person
marking them by hand, which is slow, subjective, and available in quantities of
about ten. A *rendered* cube comes with the cube: the mesh, the camera and the
transform are all sitting there, so where its twelve edges land in the image is
arithmetic. Change the pose and it is arithmetic again, a thousand times, for
free. That is the whole reason `design-lab-model.md` §5 has a ground-truth section at all.

**The three limits, which are not fine print.** Every number scored against
geometric ground truth has to be read with these in view:

- **A geometric edge need not be a visible one.** Two walls meeting under flat
  lighting produce no gradient at all. Failing to detect it is not a failure.
- **A visible edge need not be geometric.** Shadow boundaries, specular
  terminators and texture are real image edges, and none of them are in the
  geometry. A "false positive" against this ground truth may be a perfectly
  good detection of something that is not a shape.
- **The ground truth resolves what the image cannot.** A table top 5 cm thick
  seen from four metres has two edges in the model and one in the picture.

So the honest reading of a match rate here is *how much of what the pipeline
found is explained by geometry* — not *how often the pipeline is right*.

**Related terms.** A **fixture** is the input a test runs on; ground truth is
the answer it is graded against. **Annotation** or **labelling** is ground truth
produced by people. **Synthetic data** is the approach this project takes: build
the scene, and the labels come out of the construction rather than out of a
person.

**Elsewhere**: every supervised machine-learning dataset is ground truth plus
inputs; benchmark suites like BSDS (edges), KITTI (depth and detection) and
Middlebury (stereo) are named for their ground truth rather than their images;
and the sim-to-real gap is the standing objection to getting it this way — a
renderer's idea of an edge is cleaner than a camera's.

---

## Hysteresis (double-threshold edge tracking)

**Keep a weak edge if — and only if — it joins a strong one.**

Canny's last stage, and the answer to a problem one threshold cannot solve.
Threshold a gradient magnitude image at a single value and you must choose
between two bad outcomes:

- **too high** — strong edges survive, but they break into dashes wherever the
  edge is momentarily faint (a shallower angle, a softer boundary, a shadow)
- **too low** — edges stay connected, but noise passes too, and the result is
  speckled with fragments that are not edges at all

Two thresholds and a connectivity rule escape the trade-off:

| Magnitude | Verdict |
|---|---|
| `≥ high` | an edge, unconditionally — a **strong** pixel, used as a seed |
| `≥ low` but `< high` | an edge **only if** it connects, through other above-`low` pixels, to a strong one |
| `< low` | discarded |

So a faint continuation of a real edge is kept, because it is attached to
something confident; an equally faint speck of noise is discarded, because
nothing vouches for it. Strength is decided locally; **membership is decided by
company**.

Implemented as a flood fill: mark every strong pixel, then walk outwards
through above-`low` neighbours, marking as you go. What is never reached is
dropped.

### Why the name

Borrowed from physics, where a hysteretic system's state depends on its
history, not only on its present input — a thermostat that switches on at 18°C
and off at 20°C, so it does not chatter around a single set point. Same shape
here: whether a pixel counts as an edge depends on what it is attached to, not
on its own value alone.

### Three details that matter in practice

**Connectivity must not wrap.** This project uses 8-connectivity — diagonal
neighbours count — and, unlike a convolution, it does **not** reflect at the
image border. Reflection is right for a filter and wrong here: the last pixel
of one row does not touch the first pixel of the next, and treating them as
neighbours would join unrelated edges.

**It is order-independent, and therefore deterministic for free.** A pixel
either reaches a strong seed or it does not, so the traversal order cannot
change the answer. Unlike a reduction (`design-lab-model.md` §5, determinism
rule 1), no care is needed about the order work happens in.

**`low` must not exceed `high`.** The lab refuses rather than silently
reinterpreting. A common starting point is a 1:2 or 1:3 ratio — `low=0.05,
high=0.15` are this project's defaults — but the right values depend entirely
on the image, which is what `stats` is for.

**Elsewhere**: the same two-threshold-plus-connectivity idea appears as
*hysteresis thresholding* in segmentation generally, not only in Canny.

---

## Interleaved vs planar

**Two ways to arrange multi-channel pixels in memory.**

For three pixels of RGB:

```
interleaved   R G B  R G B  R G B          layout (y, x, c)
planar        R R R  G G G  B B B          layout (c, y, x)
```

**Interleaved** keeps all channels of one pixel together. Good when an operation
touches every channel of a pixel at once — blending, colour conversion,
display. It is what `<canvas>` uses for RGBA.

**Planar** keeps each channel contiguous. Good when you process one channel at a
time, and better for SIMD, because consecutive memory values are all the same
channel and can be loaded into a vector register directly.

**Why it matters here.** `design-lab-model.md` §2 chooses interleaved: it
matches the canvas layout, keeps the display path simple, and suits per-pixel
work. A kernel that genuinely needs planar can convert locally rather than
changing the global format.

**Elsewhere**: audio has exactly the same split (interleaved stereo samples vs
separate channel buffers); video formats describe themselves as *packed* or
*planar* YUV; machine learning frameworks argue about NHWC (channel-last,
interleaved) vs NCHW (channel-first, planar) for the same performance reasons.

---

## Isolated world

**A separate JavaScript execution context that shares a page's DOM but has its
own global object and its own copies of every built-in.**

Chromium's term. "World" and "V8 context" mean effectively the same thing here.

**Why it exists:** so privileged code can manipulate a page's DOM without the
page being able to reach back and tamper with that privileged code. The page
cannot see the isolated world's variables, cannot modify its `Object.prototype`,
and cannot get at anything it was not deliberately handed.

**The mechanism** — the part that makes it click: DOM objects (the document,
elements, the canvas) are **C++ objects inside Blink**. JavaScript only ever
holds *wrappers* pointing at them. Each world gets its own wrappers pointing at
the same C++ objects. So both worlds see one canvas through two different
JavaScript objects.

**In this project:** `contextIsolation: true` creates an isolated world for the
preload script. Hence the two consequences measured in `electron-guide.md` §1 —
the preload can reach `document.getElementById('canvas')` because the DOM is
shared, but `contextBridge` copies typed arrays because the JavaScript heaps
are not.

**Elsewhere**: Chrome extension content scripts run in isolated worlds. It is
the identical mechanism; Electron reuses it rather than inventing its own.

---

## Kernel signature

**Two overloaded words. Together: the parameter list and return type of one of
the C functions that does the actual pixel work.**

### "kernel"

Three unrelated meanings, two of which appear in this project — which is why
the word is worth pinning down:

| Sense | Meaning | Used here? |
|---|---|---|
| **compute kernel** | the *function* that processes the data | **yes** — this is the sense in both documents |
| **convolution kernel** | the small matrix of *weights* applied to a neighbourhood, e.g. a 3×3 Sobel kernel | yes, when discussing convolution specifically |
| **OS kernel** | the core of an operating system | never |

Both of the first two will turn up in the same project, and occasionally in the
same sentence: *"the convolution kernel applies a 3×3 kernel of weights."*
Context is the only thing that separates them.

### "signature"

A function's **interface**: its name, the parameters it takes — their types and
their order — and what it returns. Not the body. Borrowed from *type
signature*.

```c
cv_status cv_sobel(const CvBuffer *src, CvBuffer *dst,
                   CvSobelParams params, const CvKernelCtx *ctx);
```

Everything on those two lines is the signature. What the function *does* is not.

### Why the documents insist on settling it early

**C has no default parameters.** C++ does; C does not. So adding one parameter
later means editing every kernel definition *and* every call site. With twenty
kernels that is mechanical, tedious, and easy to get subtly wrong — which is
why `design-lab-model.md` §3 and §9 say to put the cancellation flag and the
ROI rectangle in from the very first kernel, before any UI uses them.

**A shared signature shape also lets the registry dispatch uniformly.** If every
kernel takes the same shape of arguments, the registry can hold them all as a
single function-pointer type and call any of them the same way. Signatures that
drift apart force hand-written glue for each operation.

**Elsewhere**: *method signature* in Java and C#, *type signature* in Haskell
and TypeScript, and *function prototype* in a C header — a prototype is
literally a signature with no body. In languages with overloading, the
signature is what distinguishes two functions sharing a name.

---

## Label map

**An image in which each pixel's number is an *identity*, not a measurement.**

Produced by segmentation — connected components, watershed, superpixels. A pixel
holding `7` means *"this pixel belongs to region 7"*. By convention `0` is
background.

**The number is a name.** Arithmetic on it is meaningless: region 7 is not
"more" than region 3, and their average of 5 is not "between" them — it is some
unrelated region, or none at all.

That single fact drives every piece of special handling the design document
gives them:

| Rule | Because |
|---|---|
| stored as **`i32`, not `f32`** | identity must be exact; float rounding silently merges or invents regions. This is the one deliberate exception to the f32-everywhere rule in `design-lab-model.md` §2 |
| **never interpolate** — nearest-neighbour only | bilinear sampling between label 3 and label 9 yields 6, a region that may not exist |
| **never filter** | blurring a label map is nonsense; morphological work is done per-label |
| **categorical colormap** | a sequential map would imply an ordering that does not exist |

### Related terms you will meet alongside it

- **binary mask** — the simplest case: 0 and 1 (or 0 and 255), foreground versus
  background. A `threshold` produces one.
- **connected components** — the operation turning a binary mask into a label
  map, by finding groups of touching pixels and numbering them.
- **region properties** — area, centroid, bounding box and so on, computed per
  label. Usually the step after producing a label map, and the point at which
  images become measurements.

---

## Mark of the Web (MotW)

**A marker the operating system attaches to a file that arrived from the
internet, so that security software knows to be suspicious of it.**

| OS | Where the marker lives |
|---|---|
| Windows | an NTFS *alternate data stream* named `Zone.Identifier`, containing `[ZoneTransfer]` / `ZoneId=3` |
| macOS | an extended attribute named `com.apple.quarantine` |

An **alternate data stream** is an NTFS feature letting a file carry additional
named blobs of data alongside its main contents. They do not show up in normal
directory listings, which is why the marker is invisible until you look for it.

**Why it matters here.** SmartScreen and Gatekeeper do not inspect your binary
and decide it is untrustworthy — they act *only when the marker is present*.
Downloading through a browser attaches it. Extracting from a ZIP, copying via
USB, or `scp` strips it.

That is exactly what happened in this project: an unsigned installer, fetched as
a CI artifact ZIP and extracted, installed on Windows 10 with no warning at all,
because there was no marker. A valid test of *does the app work*, and a
worthless test of *what a user will see*.

**Elsewhere**: the "This file came from another computer and might be blocked"
message in a Windows file's Properties dialog, and the **Unblock** checkbox
beside it, are this same marker.

---

## NMS — non-maximum suppression

**Two different algorithms share this name.** Both act on the idea "where
several responses describe the same thing, keep the strongest" — and there the
resemblance ends. Code for one is useless for the other, and neither is a
special case of the other.

| | **Edge NMS** (this project) | **Detection NMS** |
|---|---|---|
| Acts on | every pixel | a list of bounding boxes |
| Compares | one pixel against 2 neighbours | box overlap, by IoU |
| Needs sorting? | no ordering at all | yes, by confidence score |
| Produces | thinner edges | fewer duplicate detections |
| Cost | O(pixels) | O(detections²) |

**Search results will give you the wrong one.** Object detection is where most
current writing about "NMS" points, so a plain search describes boxes and IoU.
Look for *"non-maximum suppression Canny"* or *"edge thinning"* instead.

### Edge NMS — the one the `nms` operation implements

Stage three of Canny. A gradient magnitude image has *ridges* several pixels
wide, because blurring spread the edge out; an edge is one pixel. So for each
pixel, look along the **gradient direction** — across the ridge, not along it —
and keep the pixel only if it is at least as large as the two neighbours in
that direction. Everything else becomes zero.

Looking along the gradient is the whole trick. Comparing against all eight
neighbours would erase the edge itself, since neighbouring pixels *along* an
edge have similar magnitudes and are supposed to survive.

The direction is quantised to four — horizontal, vertical, and the two
diagonals — which is why `nms` needs `gx` and `gy` and not just the magnitude.

One subtlety in this implementation: the comparison is asymmetric, `>` on one
side and `>=` on the other. With `>=` both ways, a ridge exactly two pixels
wide keeps both pixels, and thinning is the entire purpose of the stage.

### Detection NMS — the one you will find first

Given many overlapping boxes proposed for the same object: drop everything
below a confidence threshold, sort the rest by score, take the highest, discard
every remaining box whose Intersection-over-Union with it exceeds a threshold,
and repeat. **Soft-NMS** is the variant that decays the scores of overlapping
boxes instead of deleting them, which behaves better in crowded scenes.

Nothing in this project does this, and it would need a detector first.

**Elsewhere**: the same word collides in signal processing, where "non-maximum
suppression" means peak-picking in a 1-D signal — the same idea again, in one
dimension.

---

## Notarization

**Apple-specific: uploading a signed app to Apple's automated service, which
scans it and returns a "ticket" saying it passed.**

**Not the same as code signing**, and both are required:

| Step | What it is |
|---|---|
| **Code signing** | *You* assert authorship, using your Developer ID certificate |
| **Notarization** | *Apple* additionally scans the build for malware and misconfiguration, and blesses it |

**Stapling** attaches the returned ticket to the app bundle, so Gatekeeper can
verify it without an internet connection. `xcrun notarytool submit --wait`, then
`xcrun stapler staple`.

Since macOS 10.15, distributing outside the App Store requires both. Without
them Gatekeeper refuses to open the app — a harder block than Windows, which
merely warns.

**It is not App Review.** No human looks at your app, no judgement is made about
what it does. It is an automated malware and configuration scan, usually taking
5–15 minutes. It requires the hardened runtime, correct entitlements, and every
nested binary signed — including the `.node` sitting in `app.asar.unpacked`.

**Elsewhere**: no exact Windows equivalent. SmartScreen reputation is the loose
analogue, but it accumulates automatically over time rather than being granted.

---

## Precision and recall

**Two numbers for two different ways of being wrong, and you need both because
either one alone is trivially gamed.**

| | Question | Ruined by |
|---|---|---|
| **precision** | of the things I reported, how many were real? | reporting too much |
| **recall** | of the things that were real, how many did I report? | reporting too little |

Report every possible corner in the image and recall reaches 100% with
precision near zero. Report one corner you are certain of and precision reaches
100% with recall near zero. Quoting either alone says nothing.

```
precision = hit / (hit + invented)        recall = hit / (hit + missed)
```

**F1** is their harmonic mean — `2PR / (P + R)` — a single number for comparing
methods, harmonic rather than arithmetic so that being terrible at one cannot be
averaged away by being good at the other.

**Why they are the right frame for `corners`.** That operation is deliberately
built to have low precision and high recall: `design-lab-model.md` §5 says in as
many words that it produces *hypotheses, not detections*, and leaves the
deciding to a later stage. Measured against ground truth over twenty-four views
it comes out at 25% precision and 82% recall, which reads as a failure and is
the design working — nearly every real corner found, and a pile of candidates carrying
their own evidence for something downstream to sort.

**The vocabulary underneath**: a **true positive** is a hit, a **false
positive** something reported that was not there, a **false negative** something
there that was not reported. *True negative* — correctly saying nothing — is
usually meaningless in detection, since there is no finite list of things not
detected, which is why *accuracy* is not used here.

**A trap worth naming.** Both depend entirely on what counts as a match, and
that threshold is a free parameter nobody can see in the resulting percentage. A
corner three pixels from a true one is a hit at `maxDistance=3` and a miss at
`maxDistance=2`. Quote the threshold with the number or the number means
nothing — the same rule `design-lab-model.md` §5 learned about cost tables whose
parameters were not written down.

**Elsewhere**: information retrieval, where the terms come from; ROC and
precision–recall curves, which plot the trade-off as a threshold sweeps rather
than fixing it; and mAP, the object-detection standard, which is the area under
that curve averaged over classes.

---

## Range (display)

**Which span of data values maps onto the visible scale.**

A slot holds unbounded `f32` values — a gradient magnitude might run 0 to 3.7, a
signed derivative -2.1 to +2.4. A screen has 256 levels per channel. The range
picks which two data values become the ends of the colormap; anything beyond
them is clamped to the end colours.

Display-only, and non-destructive: the buffer is never modified.

**`auto min/max`** — scan the buffer and use its actual extremes.

Always shows *something*, which makes it a reasonable default. Two weaknesses:
one outlier pixel — a sensor defect, a single saturated highlight — stretches
the scale so all the real structure is squeezed into a narrow band and looks
flat. And because the mapping follows the data, two slots displayed this way are
**not comparable**: the same colour means different values in each.

**`fixed [lo, hi]`** — you state the two ends.

The only honest choice when comparing slots side by side, since a given value
must produce the same colour in both. Also stable over time, so a value does not
change appearance as other pixels change.

**`percentile (2–98%)`** — like auto, but ignoring the extreme tails.

Take the 2nd and 98th percentile as the ends instead of the true min and max.
Immune to outliers while still adapting to the data, which is why it is a common
default in scientific imaging. Costs a histogram pass to compute.

**`symmetric about zero`** — take `m = max(|min|, |max|)` and use `[-m, +m]`.

For signed data, and the partner of a diverging colormap: it guarantees zero
lands exactly on the neutral midpoint. Under `auto min/max` instead, zero would
sit off-centre and the colours would misreport sign — a slightly negative pixel
could appear on the positive side. This pairing is why `design-lab-model.md` §6
makes it the default for gradients.

**Worth knowing:** values outside the range are *clamped*, not discarded, so
clipping is invisible unless you look for it. Tools often render out-of-range
pixels in a distinct colour so that over-clipping announces itself.

---

## Remote code execution (RCE)

**A flaw that lets an attacker run code of their choosing on someone else's
machine.**

- **remote** — the attacker is not sitting at the keyboard. The code arrives
  over a network, or inside a file the victim opens.
- **code execution** — arbitrary instructions, not merely reading data. Once an
  attacker can run code as you, they can do anything you can do.

This is the top of the severity ladder. Most CVSS scores in the 9–10 range are
RCE, because everything else follows from it: read every file you can read,
install something persistent, exfiltrate, encrypt for ransom.

Neighbouring terms: **ACE** (arbitrary code execution) usually means the same
thing, with *remote* specifying how it is delivered. **LPE** (local privilege
escalation) is the different problem of already having some access and gaining
more.

**Why it matters here — two separate routes.**

**1. The `nodeIntegration` chain.** With Node exposed to page script, an
ordinary XSS bug becomes RCE in one step:

```
attacker's script runs in the page          ← XSS
        │
        │  require('child_process')          ← only possible if nodeIntegration is on
        ▼
attacker's commands run as your user        ← RCE
```

That single step is the whole reason `contextIsolation` and `sandbox` exist,
and why the defaults flipped.

**2. Your own C code.** A native addon adds a *new* RCE surface that a pure
JavaScript app does not have. Image-processing code written in C, parsing
input someone else supplied, is historically one of the richest sources of RCE
there is — a buffer overflow while decoding a malformed image hands the
attacker control of the process.

The example identifier used in the **CVE** entry above, `CVE-2023-4863`, is
exactly this: a heap buffer overflow in WebP decoding, exploited in the wild,
affecting Chrome and nearly everything else that decodes WebP.

Practical consequences for kernels in this project:

- validate dimensions *before* allocating — `width * height * channels` can
  overflow an integer and produce a buffer far smaller than the code then
  writes into
- bounds-check rather than trusting a caller-supplied length; `test/smoke.js`
  already rejects a pixel length that is not a multiple of 4
- fuzz kernels with malformed and hostile inputs once there are several

**Elsewhere**: read almost any critical security advisory and RCE is what made
it critical.

---

## Residual

**How far a data point sits from the model that claims to describe it.**

Here, specifically: the **perpendicular** distance from a pixel centre to the
line fitted through its segment, in pixels.

Perpendicular is the whole point. *Ordinary* least squares minimises **vertical**
residuals, which is fine for a graph where x is an input and y is a
measurement — and wrong for an image, where a line can run in any direction
and a near-vertical one has residuals approaching infinity. **Total least
squares** minimises perpendicular distance instead and is rotation-invariant.
That is why `segments` and `merge` fit with TLS.

`fit` reports the **maximum** residual over a segment, not the mean, so it
reads as a guarantee: *no pixel of this segment lies further than this from its
line.* A mean would let one badly-placed pixel hide behind fifty good ones.

Calibration, from constructed cases:

| Shape | Worst residual |
|---|---|
| a perfectly straight run | 0.000 |
| a one-pixel zigzag | 0.564 |
| a single one-pixel step | 0.461 |
| a 45° bend halfway along | 2.242 |

So sub-pixel values are just the noise of drawing a line onto a grid; values
above about 1 mean the thing is not a line. That is what `maxResidual` gates.

**Elsewhere**: any fitting procedure has residuals — regression, bundle
adjustment, calibration. The word always means *what the model failed to
explain*, and the interesting question is always which distance is being
measured.

See also [total least squares](#tls--total-least-squares-orthogonal-regression),
which is the fit whose residuals these are.

---

## Sidecar (sidecar file)

**A separate file stored next to a main file, holding information *about* it,
rather than putting that information inside the main file.**

Named after the passenger car bolted to the side of a motorcycle — it travels
alongside, but is not part of the bike.

```
exports/edges.png          ← the image
exports/edges.png.json     ← the sidecar: how that image was produced
```

**Why not just put it inside the file?** Sometimes you cannot: the format may
have nowhere to store arbitrary metadata. Sometimes you should not: writing to
the original changes its bytes, and therefore its content hash — which for this
project would undermine the very thing the metadata is recording.

**The cost:** the two can become separated. Copy the image somewhere and forget
the sidecar, and the provenance is gone. Nothing enforces the pairing except
the shared filename.

**In this project:** `design-lab-model.md` §5 proposes a sidecar on image
export, carrying the
ancestry of just that slot, so an exported PNG can still answer "how was this
made?"

**Elsewhere you will meet them**: `.xmp` files beside camera raw images,
`.srt` subtitles beside a video, `.json` label files beside images in machine
learning datasets.

---

## Silhouette, crease and boundary edges

**Three reasons a mesh has an edge where a picture might show a line — and only
one of them depends on where you are standing.**

| | What it is | View-dependent? |
|---|---|---|
| **silhouette** | one adjacent face points towards the camera, the other away: the object ends here against whatever is behind it | **yes** |
| **crease** | two faces meet at a sharp angle | no |
| **boundary** | only one face uses the edge — the mesh is open here | no |

**Why the split matters.** A sphere has no creases whatsoever: every pair of
adjacent facets differs by a few degrees, so no dihedral threshold finds
anything. It still has a perfectly obvious outline. Ground truth built from
creases alone would call the strongest edge in the picture an invention, so a
silhouette test has to be there too — and it has to be recomputed for every
view, since which edges are silhouette edges changes as the camera moves.

The reverse case is a cube seen straight on: its four silhouette edges are also
creases, and its remaining visible crease reads as a line down the middle of the
picture with nothing behind it.

**How they are found.** Build a map from each undirected edge to the faces using
it, then:

- one face → **boundary**
- two faces whose normals differ by more than the crease angle → **crease**
- two faces where one faces the camera and the other does not → **silhouette**

A cube's edges are both silhouette and crease; `pt-lab` reports silhouette,
because it is the stronger claim about the *image* — one side of it is not the
object at all — and keeps the dihedral angle so the sharpness is still there.

**The crease angle is a real choice.** Set it at 1° and a smooth sphere yields
every one of its 2,300 facet boundaries; set it at 20° and it yields none, which
is right. Set it too high and a genuinely faceted model stops having edges.

**Where a silhouette differs from an outline.** A silhouette edge is a property
of the geometry, and there is one wherever front meets back — including deep
inside the object's outline, where a limb passes in front of a torso. It is a
self-occlusion boundary as much as an outer boundary.

**Elsewhere**: exactly the same three cases drive non-photorealistic and
toon-outline rendering, which draws them on purpose; three.js's `EdgesGeometry`
extracts creases and boundaries and has no notion of silhouettes, because those
cannot be precomputed.

---

## Structured clone

**The algorithm browsers use to *copy* a JavaScript value across a boundary
where objects cannot be shared.**

Used by `postMessage` to a web worker, by IndexedDB when storing values, and by
Electron's `ipcRenderer` / `ipcMain`.

It is a **deep copy**: nested objects, arrays, `Map`, `Set`, `Date`,
`ArrayBuffer` and typed arrays are all duplicated by value. It correctly handles
cycles and preserves sharing *within* the copied graph.

What it cannot carry:

- **functions** — throws
- **DOM nodes** — throws
- **class identity** — a `Foo` instance arrives as a plain object; the prototype
  is lost

**Why it matters here.** Sending a 48 MB pixel buffer over Electron IPC means
serialising and copying all 48 MB, twice for a round trip. That cost is the
reason `design-lab-model.md` keeps slot buffers in the preload rather than in
the main process.

**The escape hatch worth knowing:** `postMessage` supports **transferables** —
an `ArrayBuffer` can be *moved* rather than copied, at zero cost. Ownership
transfers and the original becomes detached and unusable. That is the standard
way to get large buffers to a worker without paying for a copy.

**Elsewhere**: `structuredClone()` is now a plain global function in browsers
and in Node, usable as a general deep-copy utility.

---

## TLS — total least squares (orthogonal regression)

**A line fit that minimises each point's *perpendicular* distance to the line,
rather than its vertical distance.**

What `segments`, `merge` and `fit` all use, and the reason the endpoints this
lab reports are sub-pixel.

Ordinary least squares treats x as an input and y as a measurement, and
minimises the vertical offsets. In an image neither axis is privileged — an
edge can run in any direction — and OLS degenerates completely as a line
approaches vertical, where the vertical offsets go to infinity. TLS is
rotation-invariant: rotate the image, and you get the rotated fit.

The form used here is closed and incremental. Six running sums —
`n, Σx, Σy, Σx², Σy², Σxy` — give the 2×2 covariance, whose principal axis is
the line:

```
θ = ½ · atan2(2·cov_xy, cov_xx − cov_yy)
```

Adding a point is O(1) and the line comes back in closed form, so a region can
be refitted after *every* pixel it absorbs without the cost mattering. That is
what lets `segments` test straightness as it grows rather than afterwards.
`CvTls` in `native/kernels.h` is this struct.

Two things fall out of it that the lab depends on:

- **Endpoints are projected onto the fitted line**, not reported as the extreme
  pixels themselves. The line is an average over every pixel in the segment,
  so it localises better than any single pixel centre can — that is where the
  sub-pixel accuracy comes from.
- **The fit's own uncertainty is computable.** A fit over *n* pixels spanning
  length *L* with RMS residual *s* has angular slop of about `s·√12 / (L·√n)`,
  which is what `corners` propagates into `sigma`. `fit` reports `rms`
  alongside the maximum [residual](#residual) for exactly this reason: the
  maximum is a guarantee about the worst pixel, the RMS is what propagation
  needs.

**Elsewhere**: TLS is the errors-in-variables case of regression, and the same
principal-axis computation appears as PCA, as the inertia tensor in mechanics,
and as the covariance ellipse in statistics. All the same 2×2 eigenproblem.

---

## Topological sort

**An ordering of a DAG's nodes in which every node comes after everything it
depends on.**

Given "C needs B, B needs A", a topological sort produces `A, B, C`. Never
`B, A, C`.

**Why it exists:** whenever you have a dependency graph you eventually need a
legal order to process it in. This is the algorithm that produces one.

Two things worth knowing:

- **The answer is usually not unique.** If `D` depends on nothing, `A, B, C, D`
  and `D, A, B, C` are both valid. Any of them will do.
- **It is possible only on a DAG.** A cycle means each node must come after the
  other, which cannot be satisfied. This is precisely why the *acyclic* part of
  DAG is worth guaranteeing rather than merely observing.

**In this project:** replaying a session, or recomputing everything downstream
of a changed slot, needs a topological order. Conveniently, the append-only log
*is already one* — entries were appended in an order where inputs necessarily
existed first — so replaying in log order is always valid.

**Elsewhere**: `make` deciding what to build first, package managers ordering
installs, spreadsheets deciding which cells to recalculate, and university
course prerequisites.

---

## XSS — cross-site scripting

**An attack in which the attacker gets their JavaScript to run inside a page
that is not theirs.**

It happens when a page takes data it did not author — a comment, a filename, a
URL parameter — and inserts it into the DOM as *markup* rather than as *text*.
The browser cannot tell the difference between script the developer wrote and
script that arrived in a string.

```js
el.innerHTML = userText;   // if userText is "<img src=x onerror=alert(1)>", that runs
el.textContent = userText; // safe: inserted as text, never parsed as markup
```

The name is historical and widely considered unhelpful — it originally
described one site injecting script into another. The essence is simply
*attacker's script, your page's privileges*.

Three classic shapes:

| Kind | How the payload arrives |
|---|---|
| **Stored** | saved somewhere and served to others later — a comment, a profile field |
| **Reflected** | echoed straight back in a response — a search term redisplayed on the results page |
| **DOM-based** | never touches a server; page script reads from `location.hash` or similar and writes it into the DOM |

**Why it matters here.** In an ordinary web page, XSS gets the attacker the
powers of the *page*: cookies, session, the DOM. Serious, but bounded by the
browser sandbox. In Electron with `nodeIntegration` on, the page has
`require()`, so the same bug gets the attacker the powers of the *user
account*. See **Remote code execution** above.

**It is not only a risk for apps that load remote content.** A local-only tool
like this one still renders strings it did not author: file names, image
metadata such as EXIF fields, error messages quoting file contents, a session
file someone else shared. A filename containing `<img onerror=…>` written into
the page with `innerHTML` is a genuine XSS.

Three defences, all already in place or cheap to keep:

- **`textContent`, not `innerHTML`**, for anything not authored by you
- the **Content-Security-Policy** in `src/renderer/index.html`, which blocks
  inline and remote script
- **`contextIsolation: true`**, so that even a successful XSS cannot reach Node

**Elsewhere**: consistently near the top of the OWASP Top Ten, and the most
common web vulnerability class by report volume.
