# cv-lab-2

A computer-vision lab: Electron for the interface, hand-written C for the
pixels. Built for experimenting with image-processing kernels, with results
that can be reproduced later.

Two requirements shape the whole design — it handles **non-8-bit data**, and
every result is **reproducible** from a replayable log.

## Quick start

Needs **Node 22.12+**. There is an `.nvmrc`, so `nvm use` in this directory
picks the right one; every script checks and says so rather than failing
somewhere inside a build.

```bash
nvm use         # or nvm install, the first time
npm install     # also compiles the addon
npm test        # eleven suites, ~285 tests
npm start       # launch the app
```

Press **Open Image…**, or work without a file:

```lab
A = pattern(kind=checker, width=512, height=512)
B = gaussian(A, sigma=1.4)
E = sobel(B, axis=x)
M = threshold(E, t=0.02)
stats(E)
```

Or all the way to geometry:

```lab
Gx = sobel(B, axis=x)
Gy = sobel(B, axis=y)
G  = sobel(B, axis=mag)
N  = nms(G, Gx, Gy)
S  = segments(N, Gx, Gy, minPixels=5)
R  = merge(S)
F  = fit(R)
C  = corners(F)
```

Two details in there are the difference between geometry and an empty result,
and both were wrong in this file until a test started running it:

- **`nms` takes the magnitude, not a single derivative.** It thins ridges, and
  a signed `axis=x` response is negative on half its edges — which `nms` reads
  as no edge at all and discards.
- **`minPixels=5`, not the default 8.** `pattern` draws 8-pixel checker
  blocks, so after a blur and thinning no run of one is 8 pixels long. At the
  default this pipeline finds *zero* segments and every later stage dutifully
  reports nothing. On a photograph the default is the right number; on this
  particular synthetic image it is one larger than anything that exists.

Blocks marked `lab` here are executed by `test/readme.js`, so an example that
stops working fails the build rather than the reader.

Turn on **fits** in the toolbar to draw the results over the image they came
from.

The command bar lives in the app header — it is the primary interaction, so it
is not a pane you can close or lose. Everything else is in the **application
menu**: scaling (a radio group), the fits overlay (a checkbox), Reset View, the
session actions and the pane commands.

Each command fills a **slot pane** — an empty one if there is one, otherwise a
new one, up to four. Panes are [paneless](../paneless-workspace) frames: split
them, tab them, drag them between frames, resize them. Hover anywhere to read
that pixel **in every slot at once**; scroll to zoom — all panes move together,
because they all read one shared viewport. Pick an operation from the menu to
have its command written into the bar for you.

Notice that `E` renders on a diverging colormap centred on zero, because a
Sobel response is signed, and `M` renders categorical, because a mask is an
identity rather than a measurement.

## How it works

**Slots** (`A`, `B`, …) are uniform, user-created, and hold a typed buffer —
`width, height, channels, dtype, space` — not a canvas. A canvas is 8-bit RGBA
only, so slots-as-canvases would clamp away half a gradient. `f32` is the
working format, with `i32` for label maps.

**Operations** are one registry entry plus one C kernel, and produce one of
three things: a **buffer** of pixels, a **feature** list (line segments with
endpoints, angles and lengths), or **scalars**. The registry is the single
source of truth for the menus, the parser's validation, generated help, and the
shape of a provenance record.

**The log is the point.** Every command appends an immutable entry with fully
resolved parameters and a content hash of the output. `A = gaussian(A)` produces
`A#2` while still recording that it consumed `A#1` — names move, history does
not. Save a session and replay it, and a hash mismatch tells you a kernel
changed.

## Layout

```
native/buffer.*        the buffer type: allocation, dtypes, overflow-checked sizing
native/kernels.*       the thirteen kernels, behind one uniform C signature
native/render.*        display transforms and downsampling, done in C
native/addon_*.c       the Node-API surface
src/lab/registry.js    operation definitions, validation, provenance records
src/lab/parser.js      the command language
src/lab/session.js     slots, execution, the log, the provenance graph
src/lab/corners.js     corner hypotheses (pure JS — no pixels involved)
src/main.js            main process: window, dialogs, menu wiring
src/menu.js            the application menu template
src/preload.js         owns the session and every buffer handle
src/renderer/          Svelte 5 + paneless: App, lab state, the header command
                       bar, and one component per pane. No require, no fs,
                       no pixels
dist-renderer/         Vite's output — the only thing the window ever loads
scripts/png.js         a PNG encoder, and the colour chunks `load` reads
test/                  ten suites under plain node, plus test/renderer.js
                       which needs a real Electron renderer
docs/cv-lab-users-manual.md  how to operate it: every operation, every parameter
docs/electron-guide.md   builds, CI, packaging, signing, costs (written after doing it)
docs/design-lab-model.md slots, ops, commands, reproducibility (written before)
docs/glossary.md         terms used in all three, explained from scratch
notes/                   working notes; unlike docs/, never obliged to be current
```

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Everything |
| `npm run build:native` | Compile the addon with node-gyp |
| `npm run build:renderer` | Vite build of the Svelte renderer |
| `npm run lab` | Run a pipeline over images, headless — see below |
| `npm run build:generate` | Build the pt-lab image generator (needs the sibling checkout); refuses a bundle whose pt-lab is behind the code calling it |
| `npm run dev:generate` | The same, in watch mode, for editing pt-lab alongside |
| `npm run generate` | Render images with varying position and lighting, optionally with ground truth |
| `npm run score` | Tally what the pipeline found against what is really there |
| `npm run overlay` | Draw ground truth and detections over an image, so you can look |
| `npm run rebuild:electron` | Rebuild against Electron's headers |
| `npm start` | Launch the app |
| `npm run package` | Unsigned installers into `dist/` |
| `npm run verify:package` | Assert the addon and the generator survived packaging |
| `npm run smoke:package` | Launch the packaged app and check it actually works |

## Running it without the app

```bash
npm run lab -- --script pipelines/geometry.lab --out results/ assets/*.png
```

Each image gets a fresh session that begins with `A = load(...)` and then runs
your script, and writes a replayable `.session.json` — every command with its
resolved parameters and a content hash — plus a `.features.json` of the
geometry found. Exit 1 if any pipeline failed, 2 for a usage error.

It runs under Electron with no window, because `load` borrows Chromium's image
decoder and that only exists in a renderer. It drives the same `window.lab`
bridge the interface does, so the batch path cannot drift from what the app
does.

The command language is unchanged — no variables, no loops (§4). The iteration
lives in the runner, in JavaScript, which is what "embed a scripting engine
rather than grow this into a language" means in practice.

## Generating images

Change the lighting, change the pose, re-run your pipeline over the result, see
whether the geometry still comes out. That loop is what the lab is for, so the
generator **ships as part of the application**: **Panes → Generate Images…**
(⌘G) in an installed CV-Lab, with no checkout, no build and nothing else to
install. It needs a GPU capable of WebGL path tracing, takes about 20 s per
image, and adds ~17 MB to the installer.

The frame is split: parameters and progress on the left, and on the right the
tracer itself, converging while the sweep runs. Images default to
`~/Pictures/CV-Lab`, because a packaged app inherits a working directory it
never chose.

**The pane offers the scenes in `scenes/`, and nothing else.** They are
composed in pt-lab's editor and exported as JSON — one file per scene, named
for the scene, carrying its objects, their materials and transforms, the room
and a camera. `scenes/cube-1.json` ships with the repository. A scene records
the room it was composed in, so the pane has no room control: the file decides.

From a working copy there is a command line too:

```bash
npm run build:generate                       # once
npm run generate -- --out generated/ --positions 3 --lighting 2
npm run lab -- --script pipelines/geometry.lab --out results/ generated/*.png
```

It hosts [pt-lab](../pt-lab-workspace) — a GPU path tracer — orbits the camera,
varies the environment intensity, and writes one PNG per combination. `--show`
puts the render in a window of its own, which the CLI needs and the app does
not. `--dry-run` prints the sweep without rendering, which is worth doing
before committing several minutes.

The command line takes the same `scenes/` files as `--scene saved:<name>`, and
two built-in scenes the pane does not offer. **`helmet`** is pt-lab's damaged
helmet, and every number recorded in `notes/` was measured on it. **`cube`** is
a 10 cm cube on a table with a ball beside it. Both exist for their bespoke
**shot plans** — `cube`'s puts the camera 20° off the axis so no view lands on
a degenerate one, and 25° above so three faces and seven vertices show — which
a saved scene cannot express, because the editor frames one camera and the
orbit is derived from it. `--truth` and `--aovs` write what is really in the
frame alongside the render.

A scene carries its own room; `--room` overrides it, which is worth doing to
render one subject against several backgrounds. `--room none` uses pt-lab's
default HDR environment: better-looking, and a poor CV fixture, because the
blurred background and textured tabletop dominate the edge count — 446 segments
against 156 for the same object in a room. Beauty renders go
through pt-lab's own `exportPNG`, so each is **tagged sRGB** (`sRGB` + `gAMA` +
`cHRM`) and `load` confirms the encoding instead of assuming it. `--denoise`
runs OIDN over each export; it is off by default, matching pt-lab, so every
image recorded so far carries the raw path-traced noise floor.

### What needs the sibling checkout, and when

`npm run build:generate` does — for pt-lab's source, and for the model,
environment and denoiser weights it copies into the bundle. **`npm run
generate` does not**, and neither does the installed app: a built
`dist-generate/` is self-contained. That split is what lets the feature ship,
and `npm run package` builds the generator into the `app.asar`.

Two guards, because both failures are silent. The bundle is refused if it is
**older than its sources**, since a stale one runs happily and produces images
that look completely reasonable. And `build:generate` refuses a bundle whose
pt-lab does not **define** the methods `src/generate/main.js` calls — a
checkout one commit behind builds, packages and launches cleanly, then throws
the moment `--truth` is used, and that shipped once already.

It is a separate build from `build:renderer` and no part of `npm test`: it
needs a real GPU, and it would otherwise pull three.js and an OIDN WASM blob
into a renderer bundle that has no use for them. `npm run dev:generate` is the
same build in watch mode, for editing pt-lab and cv-lab-2 together.

## Checking the answers against the scene

A pipeline that reports fourteen corners is not telling you whether any of them
are real. The renderer knows — it has the meshes and the camera — so it can be
asked:

```bash
npm run generate -- --out generated/ --scene cube --truth --aovs
npm run lab -- --script pipelines/geometry.lab --as linear \
               --truth generated/ --out results/ generated/*.png
npm run score   -- results/
npm run overlay -- generated/p0-l0.png results/ overlays/
```

`--scene cube` renders a 10 cm cube on a table in a lit room. A cube has twelve
edges and eight vertices in known places, nine and seven of them visible from a
general viewpoint, which is what makes *is this corner real* a question with an
answer. The helmet is the harder case, and not because of its paint: 61% of the
segments found on it match real geometry, but its truth set lists ~3,000 visible
edges a view against ~160 detections.

`--truth` writes one `<name>.gt.json` per image: every silhouette, crease and
mesh-boundary edge projected into image space, with the fraction of it that is
really visible taken from the depth pass, plus the vertices they meet at.
`--aovs` writes the depth, normal and albedo passes it came from, into
`generated/aov/` — **untagged**, carrying linear code values, so read them with
`from=linear`.

Inside the lab it is two ordinary operations, so the comparison is logged and
content-hashed like everything else:

```lab
T  = groundTruth("generated/p0-l0.gt.json")
MF = match(F, T)
MC = match(C, T)
```

Three things every number out of this has to be read with. **A geometric edge
need not be a visible one** — two walls meeting under flat lighting produce no
gradient. **A visible edge need not be geometric** — shadows and specular
terminators are real image edges and are not in the ground truth. **The ground
truth resolves what the image cannot** — a 5 cm table top has two edges in the
model and one in the picture. So a match rate says *how much of what the
pipeline found is explained by geometry*, not *how often it is right*.

`npm run overlay` is not a convenience. Both real defects in this machinery
were found by looking at a picture rather than reading a table — see
`design-lab-model.md` §5.

## Three decisions worth knowing about

**Node-API, not NAN.** One binary works under both Node and Electron — verified,
not assumed. Electron's 8-week release cycle never forces a rebuild.

**`sandbox: false` on the window.** Required so the preload can `require()` a
real `.node`. `contextIsolation` stays on and `nodeIntegration` stays off. The
condition: this window must only ever load local, first-party content.

**Pixels never cross the contextBridge.** It deep-copies typed arrays — measured
— so the preload owns the buffers and renders into the canvas directly, with
downsampling done in C. A 12 MP slot in a 480×360 tile sends nothing at all.
Svelte owns the DOM and only the DOM: a pane hands the preload a canvas **id**,
never the element, because a DOM node cannot cross the bridge either.

All three are explained in `docs/electron-guide.md`.

## Status

Working: the buffer type, the operation registry, the command language, the
session log with provenance and replay, the display path, and the UI. Sixteen
operations — `load`, `pattern`, `gray`, `gaussian`, `sobel`, `threshold`,
`stats`, `toLinear`, `toSrgb`, `nms`, `hysteresis`, `orient`, `segments`,
`merge`, `fit`, `corners` — enough for Canny end to end, for straight edges
with sub-pixel endpoints, and for corner hypotheses carrying their own
uncertainty. Three-platform CI produces unsigned installers.

Outstanding, in rough order:

- **Higher-precision input** — `load` borrows Chromium's decoder, which returns
  8-bit RGBA. 16-bit PNG, TIFF and raw need a native decode path. See
  `docs/design-lab-model.md` §11.
- **The colour policy** — buffers carry a `space` field, operations declare what
  they need, and `load` reads PNG's colour chunks to check what a file claims.
  Whether `load` should default to `as=linear` rather than `as=srgb` is still
  open. §11 again.
- **Kernels on the thread pool** — they run synchronously today. The contract is
  already async, so this touches only the binding.
- **Cancellation UI** — the flag is threaded through every kernel already.
- **Signing and notarization** — deferred until there are users. Costs and
  order are in `docs/electron-guide.md` §5.
