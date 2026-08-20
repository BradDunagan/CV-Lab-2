# Glossary

Terms used in `design-lab-model.md` and `electron-guide.md`, explained from
scratch. The prose in those documents deliberately uses the words practitioners
use — this is the lookup table, not a replacement for them.

Alphabetical. Grows on request; if a term is missing, it belongs here.

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

## Color handling — linear vs sRGB

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
`gray` is in the first slice of operations in §10.

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

This is why §6 makes it the default for gradients: a Sobel result is signed, and
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
  the latest three majors, and why staying current is not optional (§5, Tier 2).

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
one node may be reached by more than one route. In §5's example:

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
| stored as **`i32`, not `f32`** | identity must be exact; float rounding silently merges or invents regions. This is the one deliberate exception to the f32-everywhere rule in §2 |
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
could appear on the positive side. This pairing is why §6 makes it the default
for gradients.

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

**In this project:** §5 proposes a sidecar on image export, carrying the
ancestry of just that slot, so an exported PNG can still answer "how was this
made?"

**Elsewhere you will meet them**: `.xmp` files beside camera raw images,
`.srt` subtitles beside a video, `.json` label files beside images in machine
learning datasets.

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
