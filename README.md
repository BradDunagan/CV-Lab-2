# cv-lab-2

A computer-vision lab: Electron for the interface, hand-written C for the
pixels. Built for experimenting with image-processing kernels, with results
that can be reproduced later.

Two requirements shape the whole design — it handles **non-8-bit data**, and
every result is **reproducible** from a replayable log.

## Quick start

```bash
npm install     # also compiles the addon
npm test        # six suites, ~120 tests, no Electron needed
npm start       # launch the app
```

In the command bar:

```
A = pattern(kind=checker, width=512, height=512)
B = gaussian(A, sigma=3)
E = sobel(B, axis=x)
M = threshold(E, t=0.02)
stats(E)
```

Each command creates a tile. Hover anywhere to read that pixel **in every slot
at once**; scroll to zoom — all tiles move together. Pick an operation from the
menu to have its command written into the bar for you.

Notice that `E` renders on a diverging colormap centred on zero, because a
Sobel response is signed, and `M` renders categorical, because a mask is an
identity rather than a measurement.

## How it works

**Slots** (`A`, `B`, …) are uniform, user-created, and hold a typed buffer —
`width, height, channels, dtype, space` — not a canvas. A canvas is 8-bit RGBA
only, so slots-as-canvases would clamp away half a gradient. `f32` is the
working format, with `i32` for label maps.

**Operations** are one registry entry plus one C kernel. The registry is the
single source of truth for the menus, the parser's validation, generated help,
and the shape of a provenance record.

**The log is the point.** Every command appends an immutable entry with fully
resolved parameters and a content hash of the output. `A = gaussian(A)` produces
`A#2` while still recording that it consumed `A#1` — names move, history does
not. Save a session and replay it, and a hash mismatch tells you a kernel
changed.

## Layout

```
native/buffer.*        the buffer type: allocation, dtypes, overflow-checked sizing
native/kernels.*       the six kernels, behind one uniform C signature
native/render.*        display transforms and downsampling, done in C
native/addon_*.c       the Node-API surface
src/lab/registry.js    operation definitions, validation, provenance records
src/lab/parser.js      the command language
src/lab/session.js     slots, execution, the log, the provenance graph
src/main.js            main process: window, save dialog
src/preload.js         owns the session and every buffer handle
src/renderer/          page script; no require, no fs, no pixels
test/                  six suites, runnable under plain node
docs/electron-guide.md   builds, CI, packaging, signing, costs (written after doing it)
docs/design-lab-model.md slots, ops, commands, reproducibility (written before)
docs/glossary.md         terms used in both, explained from scratch
```

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Everything |
| `npm run build:native` | Compile the addon with node-gyp |
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

All three are explained in `docs/electron-guide.md`.

## Status

Working: the buffer type, the operation registry, the command language, the
session log with provenance and replay, six kernels (`pattern`, `gray`,
`gaussian`, `sobel`, `threshold`, `stats`), the display path, and the UI.
Three-platform CI produces unsigned installers.

Outstanding, in rough order:

- **`load`** — declared but with no kernel. Chromium's decoder is free and
  excellent but returns 8-bit RGBA, so anything higher-precision needs a native
  decode path. See `docs/design-lab-model.md` §11.
- **The colour policy** — buffers carry a `space` field, but whether the lab
  converts to linear on load is still open. §11 again.
- **Kernels on the thread pool** — they run synchronously today. The contract is
  already async, so this touches only the binding.
- **Cancellation UI** — the flag is threaded through every kernel already.
- **Signing and notarization** — deferred until there are users. Costs and
  order are in `docs/electron-guide.md` §5.
