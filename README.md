# cv-lab-2

Electron + native C skeleton for compute-intensive image processing.

It exercises every mechanism the real app will depend on, at a size small
enough to hold in your head: a Node-API addon operating directly on canvas
pixel memory, on a background thread, behind a `contextBridge` API — plus a CI
matrix ready to build it on three platforms.

## Quick start

```bash
npm install          # also compiles the addon
npm run test:native  # 7 smoke tests, plain node, no Electron needed
npm run sample       # writes assets/sample.png (12 MP)
npm start            # launch the app
```

Open `assets/sample.png`, then press each Invert button and watch the spinner
in the top-right corner.

- **Invert (async, native)** — spinner keeps turning. Work runs on libuv's
  thread pool.
- **Invert (sync — freezes UI)** — spinner stalls. Same C kernel, called on the
  UI thread. This is what you're avoiding.

Measured on this machine (M-series, 12 MP image): **24 ms** end to end, of
which 7–10 ms is the C kernel and the rest is `getImageData`/`putImageData`.

## Layout

```
native/addon.c      the addon: kernel, argument checks, async work, promise
native/portable.h   cross-compiler shims (MSVC vs clang vs gcc)
native/index.js     thin JS wrapper — nothing else touches build/
binding.gyp         build config
src/main.js         main process: window, native file dialog over IPC
src/preload.js      the bridge — the only place with Node access
src/renderer/       page script; no require(), no fs, no ipcRenderer
test/smoke.js       runs under plain node
scripts/            electron rebuild helper, sample image generator
.github/workflows/  the three-platform CI matrix (inert until pushed)
docs/electron-guide.md   ← builds, CI, packaging, signing, costs (written after doing it)
docs/design-lab-model.md ← slots, ops, commands, reproducibility (written before)
docs/glossary.md         ← terms used in both, explained from scratch
```

## Scripts

| Command | What it does |
|---|---|
| `npm run build:native` | Compile the addon with node-gyp |
| `npm run rebuild:electron` | Rebuild against Electron's headers |
| `npm run test:native` | Smoke tests under plain node |
| `npm run sample` | Generate `assets/sample.png` |
| `npm start` | Launch the app |

Because this is a **Node-API** addon, one binary works under both Node and
Electron — verified, not assumed. `rebuild:electron` is a convenience here, not
a requirement. That stops being true the moment anything in the chain uses
NAN/raw V8.

## Two decisions worth knowing about

**`sandbox: false` on the window** (`src/main.js`). Required so the preload can
`require()` a real `.node`, which keeps pixel buffers in one process instead of
structured-cloning ~33 MB per 4K image across an IPC boundary. `contextIsolation`
stays on, `nodeIntegration` stays off. The condition: this window must only ever
load local, first-party content.

**Pixels never cross the contextBridge.** `contextBridge` deep-copies typed
arrays in both directions — measured, and the reason `invertCanvas(id)` exists:
the preload reaches into the shared DOM for the canvas and does all pixel work
in its own context. 24.1 ms vs 30.1 ms median on 12 MP, and far less jitter.

**Node-API over NAN.** ABI stability is what decouples the addon from Electron's
8-week release cycle.

Both are explained in `docs/electron-guide.md`.

## Next

1. Push to GitHub → the CI matrix runs → three green unsigned builds.
2. Test the Windows and Linux artifacts in VMs.
3. Then signing, notarization and auto-update — in the order given at the end of
   the guide.
