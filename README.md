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
docs/electron-guide.md   builds, CI, packaging, signing, costs (written after doing it)
docs/design-lab-model.md slots, ops, commands, reproducibility (written before)
docs/glossary.md         terms used in both, explained from scratch
notes/                   working notes; unlike docs/, never obliged to be current
```

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Everything |
| `npm run build:native` | Compile the addon with node-gyp |
| `npm run build:renderer` | Vite build of the Svelte renderer |
| `npm run rebuild:electron` | Rebuild against Electron's headers |
| `npm start` | Launch the app |
| `npm run package` | Unsigned installers into `dist/` |
| `npm run verify:package` | Assert the addon survived packaging |

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
