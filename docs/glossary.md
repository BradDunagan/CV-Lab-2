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
