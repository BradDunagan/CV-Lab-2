# Electron + Native C: What You're Signing Up For

Notes from the session that produced this project. Written for an app that
does **compute-intensive image processing in hand-written C** and is
**distributed to other people** — those two facts drive most of the decisions
below.

---

## 1. How Electron is put together

Electron bundles **Chromium** (rendering) and **Node.js** (system access) into
one distributable. The process model is inherited from Chromium:

| Process | Count | Has Node? | Owns |
|---|---|---|---|
| **Main** | one | full Node | app lifecycle, windows, menus, dialogs, tray, auto-update |
| **Renderer** | one per window | no, by default | the DOM, your UI |
| **Preload** | one per renderer | yes (see sandbox note) | the bridge between the two |

`ipcMain` / `ipcRenderer` carry messages between main and renderer.
`contextBridge.exposeInMainWorld()` in the preload is how you hand the page a
narrow, explicit API instead of raw Node.

### `nodeIntegration`

A `webPreferences` flag that injects Node's globals — `require`, `process`,
`Buffer`, `__dirname` — directly into the page's `window`.

```js
webPreferences: {
  nodeIntegration: false,   // default since Electron 5
  contextIsolation: true,   // default since Electron 12
  sandbox: true,            // default since Electron 20
}
```

With it on, page script can do `require('child_process').exec(...)`. That turns
any XSS — or one compromised npm dependency, or one link opened in-app — into
remote code execution on the user's machine. It was the source of a long run of
CVEs, which is why the default flipped.

**Use the preload + `contextBridge` pattern instead.** The preload has Node
access; the page gets only the functions you deliberately expose. See
`src/preload.js`.

The three flags are easy to conflate:

- **`contextIsolation`** — runs the preload in its own V8 context so page script
  can't tamper with it via prototype pollution. This is what makes preload
  actually safe; `nodeIntegration: false` alone was historically bypassable.
- **`sandbox`** — puts the renderer in Chromium's OS-level sandbox. With it on,
  the preload gets only a **polyfilled subset** of Node and **cannot `require()`
  a real `.node` binary**.
- **`nodeIntegration`** — the dangerous one described above.

### Why this project sets `sandbox: false`

A deliberate, documented trade-off in `src/main.js`. With the sandbox on, the
native addon would have to live in the main process, and every pixel buffer
would be structured-cloned across a **process** boundary — roughly 33 MB each
way for a 4K RGBA image, on every operation. Turning the sandbox off for this
one window keeps the addon in the renderer process.

`contextIsolation` stays **on** and `nodeIntegration` stays **off**. The
condition attached to this trade-off: **this window must only ever load local,
first-party content.** Never point it at a remote URL.

### Measured: contextBridge deep-copies typed arrays

Worth knowing before designing your API, and easy to assume wrongly.
`contextIsolation` puts a boundary between preload and page script, and
**typed arrays are copied across it in both directions**. Measured on Electron
43, not assumed:

```
callerMutated:  false   <- C wrote into a copy; the page's array is untouched
sameObject:     false   <- the returned array is a third object
returnedCorrect: true   <- the data is right, but only via the return value
```

So an API shaped `invert(pixels) -> pixels` is *correct* only because it returns
the result. In-place mutation is invisible to the caller, and a 48 MB image
costs two full memcpys per call.

**The fix: don't send pixels across the bridge at all.** `contextIsolation`
isolates the *JS context*, not the DOM — preload and page script see the same
`document`. So the preload can pull the canvas over, call `getImageData`, run
the addon, and `putImageData` back, entirely inside the privileged context.
Page script sends a canvas id and gets a timing object back.

Measured on a 12 MP (4243×2829) image, median of 5 runs:

| Path | Median | Notes |
|---|---|---|
| `invertCanvas(id)` — pixels stay in preload | **24.1 ms** | stable |
| `invert(imageData.data)` — across the bridge | **30.1 ms** | 27–42 ms, jittery |
| kernel alone (inside the call) | 7–10 ms | the rest is `getImageData`/`putImageData` |

About 20% and, more importantly, most of the variance. The gap grows with image
size. Both are in `src/preload.js`; the app uses the first.

Note that `getImageData`/`putImageData` copy too — that is inherent to canvas
2D. If those become the bottleneck, the next step is keeping the authoritative
pixel buffer in C, owned by the preload, and only pushing to a canvas for
display.

---

## 2. What a `.node` file actually is

A `.node` is an ordinary dynamically-loadable shared library with a renamed
extension:

| Platform | Real format | Equivalent to |
|---|---|---|
| Linux | ELF shared object | `.so` |
| macOS | Mach-O **bundle** (`-bundle`, not `-dylib`) | `.bundle` |
| Windows | PE DLL | `.dll` |

`require('./foo.node')` dispatches on the extension to `process.dlopen()`,
which calls `dlopen`/`LoadLibrary` and then calls a registration symbol.

Your C is **compiled into** it. You do not link *against* anything called
`.node`.

### It links against almost nothing

The `napi_*` functions are provided by the host executable (`node` or
`electron`) at load time, not by a library you link:

- **Linux** — shared objects tolerate undefined symbols; the loader resolves
  them from the already-loaded host.
- **macOS** — node-gyp passes `-undefined dynamic_lookup`, same idea.
- **Windows** — PE can't do that. node-gyp links against a generated import
  library `node.lib` **and** injects `win_delay_load_hook.cc`, which redirects
  the delay-load of "node.exe" to whatever executable actually loaded the DLL.
  **That hook is precisely why the same addon works inside `electron.exe`.**
  Omit it in a hand-rolled Windows build and you get an inexplicable load
  failure.

### Node-API vs NAN — the single most important choice

- **Node-API (N-API)** — a stable C ABI. Verified in this project: the binary
  built against Electron 43's headers loads and passes all tests under plain
  Node 24 as well. One binary, both runtimes, and Electron upgrades don't
  force a rebuild.
- **NAN / raw V8** — bound to the exact V8 ABI, so it must be recompiled for
  every Electron major. This is what `@electron/rebuild` exists to fix.

This project uses Node-API (`NAPI_VERSION=8` in `binding.gyp`). It's why
`npm run rebuild:electron` is a convenience rather than a requirement here.

### If you later wrap an existing C library

Then "linked with" does apply — to *your* library, not to Node:

```python
"libraries": ["<(module_root_dir)/deps/mylib/libmylib.a"]
```

Prefer **static** linking. Dynamic means shipping the `.so`/`.dll`, setting
`@loader_path`/`$ORIGIN` rpaths, excluding it from the ASAR archive, and signing
it separately on macOS.

### The escape hatches (rejected for this project)

- **WASM** — one artifact for all platforms, no build matrix, no signing of
  native code. Costs syscalls and roughly 1.5–2× on compute-heavy code.
- **FFI** (`koffi`) — no Node-specific C, but you still need a `.so`/`.dylib`/
  `.dll` per platform, so it doesn't solve the build problem.
- **Subprocess** — crash isolation, at the cost of serialization.

Rejected because this app is performance-bound. Worth revisiting if a
particular module turns out not to be.

---

## 3. Building for three platforms

**One build command on a Mac produces macOS binaries only.** There is no flag
that changes this.

### What a Mac does give you free

Both macOS architectures, because Xcode ships both SDKs:

```bash
npx node-gyp rebuild --arch=arm64
npx node-gyp rebuild --arch=x64
lipo -create -output addon.node arm64/addon.node x64/addon.node
```

macOS universal *app* bundles are produced by `@electron/universal`, which
`lipo`-merges the two built `.app`s. This must happen **before** signing.

### The trap: packaging ≠ compiling

`electron-builder --mac --win --linux` genuinely works from a Mac — it
downloads the prebuilt Electron binary for each target, no compilation
involved. **But the moment you have a native module**, that command has to
rebuild your `.node` for each target and cannot. You either get a build error
or, worse, a Windows installer silently containing a macOS `.node` that fails
at runtime on the user's machine.

### What actually works per target

- **Linux from a Mac** — Docker, and close to one command:

  ```bash
  docker run --rm -v "$PWD":/src -w /src --platform linux/amd64 node:20 \
    sh -c "npm ci && npx node-gyp rebuild"
  ```

  Use an **older** base image than your minimum supported distro — glibc is
  forward-compatible but not backward-compatible. On Apple Silicon this runs
  through Rosetta; usually fine, occasionally miscompiles, so verify.

- **Windows from a Mac** — effectively no. In descending order of sanity: CI
  runner, Windows VM (Parallels/UTM), or `clang-cl` + `xwin`. That last one is
  workable for Rust and a research project for node-gyp.

---

## 4. CI: the matrix

Less complicated than it sounds. The concept is *run these same steps on three
rented machines instead of one*. See `.github/workflows/build.yml` — the real
one in this repo, about 50 lines.

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [macos-14, windows-2022, ubuntu-22.04]
runs-on: ${{ matrix.os }}
```

`fail-fast: false` matters: you want to see all three failures at once, not
discover them one release at a time.

### Packaging in CI, and the ASAR trap

`npm run package` runs `electron-builder` per platform, unsigned, producing
`.dmg`/`.zip`, `.exe` (NSIS) and `.AppImage`/`.deb`. Config lives in
`electron-builder.yml`. Two things in it are not optional for this project:

**1. `directories.buildResources` must not be `build`.** That is the default,
and electron-builder **excludes the buildResources directory from the packaged
app**. Our compiled addon is at `build/Release/cvlab.node`, so with the default
the binary is silently dropped and the app dies at launch. Nothing in CI would
notice — the addon compiled fine, it just never got bundled.

**2. `.node` files must be unpacked from the ASAR.**

ASAR (Atom Shell Archive) is Electron's app bundle: a JSON header of file
offsets followed by all file contents concatenated. No compression — it exists
to reduce file count, dodge Windows `MAX_PATH`, and cut the `stat`/`open`
syscalls that `require()` resolution generates. Electron patches Node's `fs` so
paths resolve transparently into the archive.

That transparency stops at `dlopen`/`LoadLibrary`, which are **OS-level** calls
with no idea what an ASAR is. A `.node` inside the archive cannot be loaded.
Hence:

```yaml
asarUnpack:
  - build/Release/*.node
```

which produces `app.asar.unpacked/build/Release/cvlab.node` as a real file. The
archive keeps the header entry marked `"unpacked": true` so Electron's patched
`fs` redirects reads to it — verified on the macOS build, where `app.asar` is
16 KB and the referenced addon is 51 KB, so nothing is double-shipped.

electron-builder auto-detects native modules under `node_modules/`. **This
addon is part of the app itself**, so it must be listed explicitly.

The same applies to anything needing a real path on disk: bundled executables
spawned via `child_process`, files handed to native APIs. And note ASAR is
**not** security — `npx asar extract` recovers everything.

`scripts/verify-package.js` asserts both traps were avoided, per platform, and
runs in CI right after packaging. Verified locally by loading the addon with
the packaged binary:

```
ELECTRON_RUN_AS_NODE=1 cv-lab-2.app/Contents/MacOS/cv-lab-2 -e "require('...app.asar.unpacked/.../cvlab.node')"
→ loaded from packaged bundle: [245,235,225,128]
```

Two consequences worth remembering: **nothing inside an ASAR is writable**, so
user data belongs in `app.getPath('userData')`; and on macOS each unpacked
native binary is one of the nested binaries that must be signed inside-out, so
`asarUnpack` and code signing are linked.

### Add it early

The moment one native function loads successfully in Electron on your Mac.
The cross-platform failures are all structural, not logic bugs:

- missing `win_delay_load_hook` on Windows
- glibc too new on Linux
- `.node` swallowed by the ASAR archive — fix with `"asarUnpack": ["**/*.node"]`,
  because `dlopen` cannot read from inside an ASAR
- x64/arm64 mismatch in the packaged app

Each is a 15-minute fix in a 100-line project and a miserable afternoon in a
5,000-line one.

### Cost

Free for public repos. Private repos get 2,000 min/month on the Free tier, but
**macOS runners bill at 10×** and Windows at 2× — a 10-minute Mac build costs
100 minutes of quota. Fine for tagged releases, not for every commit.

### Publishing the addon separately

If you ever ship the native module as its own npm package rather than bundling
it, use **prebuildify**: each CI runner builds, all binaries go into the tarball
under `prebuilds/<platform>-<arch>/`, and `node-gyp-build` picks at require
time. Consumers then need no compiler at all.

---

## 5. The tedious parts of distributing to other people

### Tier 1 — genuinely tedious

**1. Windows code signing — the worst item on this list.**

Since June 2023, code-signing private keys must live in certified hardware. You
can no longer buy a cert, get a `.pfx`, and sign in CI from a file.

| Option | Rough cost | Notes |
|---|---|---|
| Azure Trusted Signing | ~$10/mo | Cheapest, CI-friendly. Eligibility rules (org age / identity validation) have shifted — verify current terms |
| SSL.com eSigner | ~$300–600/yr | Cloud signing, works in CI |
| DigiCert KeyLocker | higher | Enterprise-oriented |
| Certum (open source) | ~$100 + token | Physical USB token — awkward in CI |

Unsigned, every user gets SmartScreen's full-screen *"Windows protected your PC
— Unknown publisher"*, with "Run anyway" hidden behind "More info." Most
non-technical users stop there. OV certs accumulate reputation over weeks of
downloads; EV certs skip the wait and cost more.

**2. macOS signing + notarization.** $99/year Apple Developer Program. Per build:

- Sign with a **Developer ID Application** certificate
- Enable the **hardened runtime** with the entitlements V8 needs:
  ```xml
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  ```
- Sign **inside-out**: your `.node`, every Electron helper app, every framework,
  then the outer bundle. Miss one nested binary and notarization rejects
  everything.
- `xcrun notarytool submit --wait`, then `xcrun stapler staple`
- Universal binaries must be `lipo`-merged **before** signing

Notarization usually takes 5–15 minutes, occasionally hours when Apple's service
is backed up — which will happen on a release day. Unsigned on macOS is worse
than on Windows: Gatekeeper flatly refuses to open the app.

**3. Auto-update.** `electron-updater` + GitHub Releases is the standard free
path. Two hard constraints:

- **macOS auto-update requires a properly signed app** — Squirrel.Mac validates
  the signature. Not optional.
- The release job must publish `latest.yml` / `latest-mac.yml` /
  `latest-linux.yml` alongside the installers, matching exactly.

A bad release auto-updates to everyone. Have a rollback plan before you need one.

**4. Native crash diagnostics.** Specific to having a C addon, and easy to
overlook: a segfault takes down the entire app instantly — no JS exception, no
stack trace, no dialog. From a user's Windows machine with no symbols, that's
close to undebuggable. Electron bundles **Crashpad**; wire up `crashReporter`
early and upload debug symbols per platform per release. Otherwise every bug
report is "it just closes."

### Tier 2 — moderate, mostly one-time

- **Installers.** NSIS config for Windows (per-user vs per-machine, uninstall
  cleanup, file associations). On Linux pick **one or two** formats — AppImage
  plus `.deb` covers most people. AppImage + deb + rpm + Snap + Flatpak is a
  real time sink for little gain.
- **Linux glibc floor.** Build in an older container or your binaries won't run
  on older distros.
- **Electron's release treadmill.** New major every ~8 weeks; only the latest
  three get security patches, so roughly a 6-month upgrade cycle whether you
  want one or not. Node-API means the addon survives untouched.
- **CI secrets management.** Certs, passwords and API keys as encrypted
  secrets — and you can't test signing locally without the real credentials.
- **Testing on platforms you don't own.** CI proves it *builds*. It doesn't
  prove the UI works on Windows, that HiDPI scaling is right, or that file
  dialogs behave. Budget for a Windows VM and a Linux VM.
- **Antivirus false positives.** New, low-reputation Windows binaries doing
  heavy memory work sometimes get quarantined. Signing helps; occasionally you
  file a false-positive report.

### Not signing up for

- **No third-party native library builds** — the usual worst part, absent here
  because the kernels are hand-written.
- **Node-API** means no rebuild when Electron updates.
- **Skip the Mac App Store and Microsoft Store.** MAS requires the app sandbox,
  which conflicts badly with native addons and filesystem access. Direct
  download is normal for this kind of tool.

### Money

**Roughly $200–700/year recurring** — Apple $99, Windows cert $120–600, CI
likely free.

---

## 6. C portability, since the kernels are hand-written

Three compilers: clang (macOS), MSVC (Windows), gcc (Linux). See
`native/portable.h` for the shims.

- **`long` is 32-bit on Windows** (LLP64) and 64-bit on macOS/Linux (LP64). Use
  `stdint.h` types and `size_t` everywhere. This truncates **silently** on large
  images rather than failing to compile.
- **No variable-length arrays in MSVC.** `float k[n][n];` will not build.
- **Aligned allocation differs.** C11 `aligned_alloc` is absent on MSVC; its
  `_aligned_malloc` must be paired with `_aligned_free` — mismatching them
  corrupts the heap. Wrap both on day one.
- **`restrict` is `__restrict` on MSVC.** Worth having; it materially helps
  pixel-loop optimization.
- **Threading.** pthreads vs Win32. **OpenMP does not work with Apple's stock
  clang** without installing `libomp` — it builds on Linux/Windows CI and fails
  on your dev machine.
- **SIMD.** You develop on arm64/NEON; most users run x86-64/AVX2. Performance
  tuning on the Mac will not transfer. Write correct scalar C first, benchmark
  on both, then add SIMD behind runtime dispatch (Google Highway or `simde` if
  you want one source for both).

Endianness is not a concern; all three targets are little-endian.

### Threading rules for the addon

- The `Execute` callback of `napi_create_async_work` runs on a **background
  thread** and must not touch `napi_env` or any `napi_value` — only plain C data
  captured up front.
- Hold a `napi_ref` on any JS buffer the worker thread touches, or GC can
  collect it mid-flight. Released in the `Complete` callback. See
  `native/addon.c`.
- libuv's pool defaults to **4 threads**; raise with `UV_THREADPOOL_SIZE`. For
  parallelism *within* a single image you'll want your own pool eventually.
- **Never copy pixel buffers across the JS boundary.** Use
  `napi_get_typedarray_info` to operate on the backing store directly. The smoke
  test asserts this is actually happening at the C level — and see the
  contextBridge measurement above for the boundary that is *not* free.

---

## 7. Order of work

| Phase | Do this |
|---|---|
| **Now** | App + addon on the Mac. Portable C from the start. ✅ done |
| **Week 1–2** | CI matrix, unsigned builds, three green artifacts. Test the Windows/Linux output in VMs. |
| **Before first outside user** | Apple Developer account, macOS signing + notarization. Crash reporter. |
| **Before wider release** | Windows cert, auto-update, installer polish. |

**None of the Tier 1 items block development**, and every one of them is easier
to solve against a working build than against an idea. Three green unsigned
builds is the milestone that de-risks everything else.
