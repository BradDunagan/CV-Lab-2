# pt-lab

Photo-realistic, not-necessarily-realtime rendering with [three.js](https://threejs.org) and [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer), plus a scene editor. It exists to generate images for cv-lab: the lab's core loop is varying lighting and pose and re-running a pipeline over the result, and pt-lab is what renders them — along with the ground truth (projected geometry, depth, normal and albedo passes) the pipeline is scored against.

**It lives here now.** pt-lab began as its own repository, [BradDunagan/pt-lab](https://github.com/BradDunagan/pt-lab), an npm-workspaces monorepo with the library in `packages/pt-lab` and a demo app in `packages/demo`. It had no purpose besides cv-lab, and being a sibling checkout was a liability — a build could package a pt-lab one commit behind the code calling it, and once did. So the library moved in at that repository's commit `29b9957`, whose history stays there. The demo did not: cv-lab's Scene Editor frame (`src/generate/Editor.svelte`) replaces its editor, and the Generate frame replaces its exports. Where this document describes a UI, it is that frame's.

By default the library loads a glTF model (Khronos Damaged Helmet) under an HDR environment (Poly Haven "Royal Esplanade"); a scene applied with `applyScene` replaces both.

## How it works

`three-gpu-pathtracer` is a WebGL2 path tracer built on `three-mesh-bvh`:

1. When `setScene()` is called, it collects the scene's geometry, materials, textures, and lights, builds a **BVH acceleration structure**, and packs everything into GPU textures.
2. Each call to `renderSample()` runs one path-tracing pass in a full-screen fragment shader and **accumulates** it with previous passes. Image quality is a function of accumulated sample count — noise fades as samples grow.
3. Any camera/material/environment change resets accumulation to sample 0 (via `updateCamera()`, `updateMaterials()`, `updateEnvironment()`, or `reset()`).

This maps well onto "photo-realistic stills": let the tracer run for seconds-to-a-minute and export the converged frame.

## Project structure

The library is consumed from source: `vite.generate.config.mjs` aliases `'pt-lab'` to `pt-lab/src/index.ts`, and cv-lab's Vite compiles it into `dist-generate/`. Its dependencies (three, three-gpu-pathtracer, three-mesh-bvh, oidn-web) are cv-lab's devDependencies — bundled, so none is needed at run time.

| Path | Role |
|---|---|
| `pt-lab/src/index.ts` | Public barrel — what `'pt-lab'` resolves to. Exports `PathTracerLab` + types, the components, and the persistence/bundled modules. |
| `pt-lab/src/lib/pathtracer.ts` | **The reusable core.** Framework-agnostic class wrapping renderer, scene, controls, and `WebGLPathTracer`. Talks to the host only through public methods and callbacks (`onStatus`, `onObjectsChanged`). Also owns the Scene Editor model — object registry, room swapping, serialize/apply, `.glb` import — and the ground-truth and AOV exports. Asset URLs are configurable via `LabOptions`. |
| `pt-lab/src/lib/PathTracerViewer.svelte` | Thin Svelte binding: mounts the class on a canvas, wires `ResizeObserver`, disposes on unmount. |
| `pt-lab/src/lib/TransformPanel.svelte`, `MaterialPanel.svelte`, `LightPanel.svelte`, `BundleTree.svelte` | Inspector panels + the bundled-objects tree. |
| `pt-lab/src/lib/scenes.ts`, `library-store.ts` | Persistence for named scenes (localStorage — unused by cv-lab, which saves scenes as files) and imported `.glb` objects (IndexedDB). |
| `pt-lab/src/lib/bundled.ts` + `src/assets/imports/` | Build-time enumeration of bundled importable objects (travels with the library). |
| `pt-lab/assets/` | The default model, HDR environment and denoiser weights. Nothing imports them — the page fetches them by URL — so the build copies them beside it into `dist-generate/assets/`. |
| `src/generate/main.js` | The generator's page: drives `PathTracerLab` for `npm run generate` and the Generate frame. |
| `src/generate/Editor.svelte` | The Scene Editor: pt-lab's editor UI, ported from the old demo, saving to `scenes/`. |

## Rooms

A scene's `room` is one of three, and the choice is about how its lamp is lit. (The old demo also offered the bare helmet and a procedural scene under the photographic HDR environment; the generator's `--room none` is that environment.)

| `room` | Contents | Lighting |
|---|---|---|
| `room` | 6×6×3 m room, table + red cube + gray ball | Room baked into a **generated** HDR env map; the light is a bright ceiling patch painted into it. Importance-sampled → converges fast, but direction-only: no parallax, and the light appears in the same direction from every point |
| `room-emissive` | same | Room as real geometry; the light is an **emissive mesh**. Physically correct falloff/parallax/occlusion, but very noisy — the path tracer does not importance-sample emissive meshes, so rays find the light only by chance |
| `room-arealight` | same | Room as real geometry; the light is a **`RectAreaLight`**, which the path tracer importance-samples → spatially correct *and* fast. Lights are invisible to rays in this pathtracer version, so the lamp's output is split 90/10 between the sampled light and a co-located emissive quad that makes the fixture visible |

The room trio is a deliberate ladder — baked environment vs. emissive geometry vs. sampled light — demonstrating why production scenes model nearby lights as sampled light objects and reserve the environment map for distant surroundings. In the rooms, `setEnvironmentIntensity` scales the lamp instead of an env map. `window.__lab` exposes the `PathTracerLab` instance for console/automation driving; the Scene Editor's view has DevTools like any other.

## Scene Editor

The Scene Editor's **Preview path-traced / Back to editing** button toggles between two modes:

- **Render** — the path-traced view.
- **Edit** — a fast **raster** preview (`renderer.render(scene, camera)` each frame, no accumulation) for composing a scene. Edits show instantly; the traced BVH only rebuilds when you return to Render. Raster fidelity is approximate — reflections need a `scene.environment` or direct light, and shadows are shadow maps (see below) rather than traced — so final quality is still judged in Render.

#### Edit-mode shadows

Raster shadow maps make placement readable — you can see what sits on what. three.js only casts them from point, spot, and directional lights, and a `RectAreaLight` explicitly has none (nor does the emissive room's lamp, which is a mesh). So each area-ish lamp gets a hidden **`SpotLight` proxy** that stands in for it while editing:

- The proxy takes 60% of the lamp's output (all of it in the emissive room, where the lamp contributes nothing to raster) and casts the shadow; the real lamp keeps the rest as fill, so shadows aren't pitch black and the walls stay lit. The proxy is wide-coned (70°, soft penumbra) to approximate an area light.
- Editor **point** and **spot** lights cast their own shadow maps directly — no proxy.
- A dim **ambient fill** stands in for the bounce light that raster lacks but the path tracer computes.
- Proxies and the ambient fill are hidden in Render mode, so the tracer never sees them (it collects only *visible* rect/spot/point/directional lights, and ignores ambient entirely). The path-traced image is unchanged by any of this.
- The **baked-env room** has no lamp object to stand in for, so it previews without shadows, lit by its environment map.

Shadow maps are static between edits: `shadowMap.autoUpdate` is off and a `shadowsDirty` flag re-renders them on the first frame after anything moves, rather than every frame.

A scene is **data**, not code: a chosen room + which objects are included + each object's material and transform + the scene's lights + the camera. The editor sidebar (in Edit mode) is: a **Room** dropdown, an **Objects** list (checkbox = in the scene, name = select for editing), a **Lights** list, and an inspector group for the selected object or light.

### Editing objects — material properties

The material controls use artist-friendly names mapped onto the underlying `MeshPhysicalMaterial` (PBR):

| Control | Maps to | Meaning |
|---|---|---|
| **Color** | `material.color` | Base color / albedo — the light the surface doesn't absorb. |
| **Shininess** | `1 − roughness` | Reflection sharpness: high = mirror-crisp highlights, low = matte/blurred. |
| **Reflectivity** | `metalness` | Dielectric ↔ conductor: low = plastic (weak reflections + diffuse color), high = metal (mirror-like, reflections tinted by the color, no diffuse). |

The two sliders together span a wide range — shiny+reflective = chrome, shiny+non-reflective = polished plastic, matte+reflective = brushed metal, matte+non-reflective = chalk. **Transform** (Position m / Rotation ° / Scale) edits the object's placement.

Why edits behave differently: material changes are cheap (`updateMaterials()` keeps the BVH); moving/scaling geometry needs a BVH refit, so it applies live in raster and rebuilds via `setScene()` on return to Render.

### Lights

**Add light** (in the Lights group) adds a light to the scene; a scene can hold any number, alongside the room's own lighting. Select one to edit it in the **Light** inspector, and remove it with **×**:

| Control | Meaning |
|---|---|
| **Name** | Display name in the Lights list. |
| **Type** | **Point** (`PointLight`, radiates in all directions), **Spot** (`SpotLight`, 45° cone with a soft edge), or **Area** (0.5 × 0.5 m `RectAreaLight`, one-sided). Spot and area lights aim at the room center (the floor origin). Changing type resets intensity to that type's default. |
| **Color** | Light color (sRGB). |
| **Intensity** | three.js physical units: candela for point/spot, nits for area. Defaults (20 cd, 80 nt) give roughly the room lamp's brightness straight below the light. |
| **Position** | World position in meters. |

Lights cast shadows in the Edit-mode preview (see [Edit-mode shadows](#edit-mode-shadows)). They are invisible to camera rays in the path tracer, so in Edit mode each one is also drawn as a small colored sphere. The spheres are rendered in a separate raster-only pass: they are never part of the path-traced scene, the BVH, or the ground-truth/depth exports. There is no light marker in Render mode.

Light edits don't need a BVH rebuild: `updateLights()` repacks the tracer's light list, immediately in Render mode or on return from Edit mode. Things to know:

- **Point lights have no size**, so their shadows are perfectly hard and they don't appear in mirror reflections. Use an Area light for soft shadows.
- **Each light added makes every light noisier.** Each sample picks one light at random, so the room lamp's soft shadows take longer to converge.
- **No directional (sun) light.** In the geometric rooms the walls and ceiling would block its infinitely distant source, so it would light the raster preview but not the path-traced render.
- **`setEnvironmentIntensity` doesn't affect editor lights**; it scales only the room lamp or the baked environment. (The generator's `--lighting` multiplies both, deliberately — see the user's manual.)
- **The room lamp is scene data**: `getLamp()` / `setLamp({ intensity, color })`, saved as `SceneData.lamp` (radiance in nits, `#rrggbb`). Its effective radiance is `lamp.intensity × setEnvironmentIntensity`. Absent from a scene, it is `DEFAULT_LAMP` — 40 nits, `#fffdf8`, the constants it replaced — and the baked room paints exactly the (40, 39.5, 38.5) it always did, because the lamp is applied as a ratio to that default. In the baked room `setLamp` regenerates the environment map; the geometric rooms recolour and rescale in place.

### Persistence

**In cv-lab, scenes are files.** The Scene Editor's Save writes `serializeScene()` to `scenes/<name>.json` and each included import's bytes to `scenes/models/`, through the main process; see the user's manual, §6. What follows is the library's own localStorage persistence, which cv-lab does not use but which still explains the `glb`/`sha256` fields its files carry.

In pt-lab's old demo, scenes were named and saved to localStorage (**New** / **Save…** / **Export** / **Delete**). **Export** downloads the current scene as `<name>.pt-scene.json` — the same `SceneData` that Save stores, pretty-printed, so a scene can be kept in a repo or moved between browsers (localStorage is per origin, and the port counts: `localhost:5173` and `localhost:5174` are different stores). Objects are referenced by library key, and an import's key only resolves in the browser that imported it — so Export also downloads the `.glb` of every **included** imported model, and each imported object in the JSON carries `glb` (that file's name, from `modelFileName`: the library name made file-system-safe, plus `-` and the first 12 hex digits of the bytes' SHA-256) and `sha256`. The hash in the name means two different models that share a name can't overwrite each other in one directory, and a model used by several scenes exports to one file. Export refuses, before downloading anything, if an included import has no hash (only where Web Crypto is unavailable — a plain-http page) or no bytes in this browser; the browser may ask once to allow several downloads. A host outside this browser gets the models back with `registerImport(key, name, bytes)`, under the scene's own keys, before `applyScene` — see [Where the editor's data lives](#where-the-editors-data-lives). There is no import button yet — paste an exported scene back with `localStorage.setItem('pt-lab.scenes', …)` or `lab.applyScene(data)` in the console. A new scene is a room with its light and no objects. The render-mode Scene dropdown lists the built-in demos (which reload) plus saved scenes (which apply live, rebuilt from scratch by `applyScene` so loading works identically from any starting point). Two storage tiers: the **object library** (Table/Cube/Ball + imports) persists globally; each **scene** stores only per-object inclusion/material/transform keyed by library key, plus its lights (scenes saved before lights existed load with none).

### Importing Blender models

**Import .glb…** (in the Objects group) adds a model to the object library; it persists (raw bytes in IndexedDB — see [Where the editor's data lives](#where-the-editors-data-lives)) and appears in every editor scene without re-importing. The **×** beside an imported object removes it. Imports are parsed once into a template and cloned per scene with independent materials, so editing one scene's copy doesn't affect others.

**Bundled objects**: a "Bundled objects" browser lists `.glb` files that ship with the library under `pt-lab/src/assets/imports/`, as a tree mirroring the folder layout. `src/lib/bundled.ts` enumerates them at build time with `import.meta.glob('../assets/imports/**/*.glb', { query: '?url', eager: true })` and assembles the flat result into a directory tree — drop a new file or subdirectory into `assets/imports/` and it appears automatically, no manifest to maintain. Clicking a file fetches its URL and runs it through the same `importGLB` as the file picker (so it joins the persistent library); files already in the library are marked and disabled.

Recommended Blender export: **File → Export → glTF 2.0**, format **glTF Binary (.glb)**. Use the **Principled BSDF** (its base color, roughness, metallic, transmission, IOR, and emission map to the material via KHR extensions). **Turn off Draco / mesh compression** — no decompressor is wired in. Apply object transforms (**Ctrl+A → All Transforms**) so the position/rotation/scale sliders behave predictably; the exporter's default **+Y up** is correct. Textured multi-MB models are fine since imports moved to IndexedDB — see [Where the editor's data lives](#where-the-editors-data-lives).

### Where the editor's data lives

Everything the editor persists is **per browser profile and per origin** — and the port is part of the origin, so `localhost:5173` and `localhost:5174` are separate stores. In cv-lab the Scene Editor is served as `gen://editor` and the generator as `gen://lab` — two origins on purpose, because `init()` loads every IndexedDB import of its origin into the library, and a shared origin would put whatever was last imported in the editor into every render. Two tiers, in two different databases:

- **Saved scenes** (`localStorage`, key `pt-lab.scenes`) are lightweight — just references and numbers (room, per-object inclusion/material/transform, lights, camera). localStorage is small, roughly 5 MB per origin, which is ample for scenes.
- **Imported objects** (**IndexedDB**, database `pt-lab`, store `imports`) are the heavy tier: every import — from the file picker *or* the bundled browser — stores the raw `.glb` bytes as an `ArrayBuffer`. IndexedDB's quota is far larger than localStorage's and the bytes are stored directly, so textured multi-MB models fit. Imports used to live in localStorage as base64; that store (`pt-lab.library`) is migrated into IndexedDB once on first open and then removed.

Quota can still be exhausted eventually (IndexedDB is bounded by available disk and browser policy). When a save would overflow, **the import is aborted** (nothing already stored is lost) and the app shows a **"Storage full — delete some scenes or objects"** message. Remove unused imports with the **×** in the Objects list.

Each import gets a generated key, `import-<base36 timestamp>-<counter>`, and scenes reference objects by that key. The key is minted per import, so the *same* `.glb` imported in another browser — or re-imported after clearing site data — gets a *different* key, and a scene exported from elsewhere won't resolve it. That is what an exported scene's `glb`/`sha256` fields and `registerImport(key, name, bytes)` are for: a host with the exported files registers each model **in memory only** under the key the scene uses, then calls `applyScene`. It never writes to IndexedDB — a host that persisted every model it rendered would reload them all on its next `init()`, and what it renders would start to depend on what it rendered before — and it refuses a key already in the library rather than replace it. It resolves with the SHA-256 of what it registered, so the host can confirm it matches the scene. A saved key with no library entry is otherwise skipped silently by `applyScene`, which walks the library, not the scene. Hashes are computed when an import is added or loaded, so they cost nothing at save time. To inspect the library:

```js
const db = await new Promise(r => { const q = indexedDB.open('pt-lab'); q.onsuccess = () => r(q.result); });
const all = await new Promise(r => { const q = db.transaction('imports').objectStore('imports').getAll(); q.onsuccess = () => r(q.result); });
all.map(i => ({ key: i.key, name: i.name, kb: Math.round(i.glb.byteLength / 1024) }))
```

## Integration notes for the larger web app

### Keep the renderer behind an abstraction

`src/lib/pathtracer.ts` is deliberately framework-agnostic — the Svelte layer is ~40 lines of glue. Two reasons to keep this boundary in the real app:

- **WebGPU is coming.** three.js's `WebGPURenderer`/TSL is the ecosystem's forward path, and WebGPU path tracers are emerging but not yet mature. Keeping the path tracer behind your own interface means you can swap the backend later without touching app code.
- **Version coupling.** `three-gpu-pathtracer` reaches into three.js internals (shaders, material properties). Pin your `three` version and re-test when upgrading. Current known-good pairing: `three@0.185` + `three-gpu-pathtracer@0.0.24` (which requires `three >= 0.180`).

### The hybrid rendering pattern

Production UX is **rasterize while interacting, path trace when idle**. `WebGLPathTracer` has this built in — the lab configures it like so:

```ts
pathTracer.rasterizeScene = true;   // draw a normal raster frame during the reset delay
pathTracer.renderDelay = 150;       // ms after a reset before path tracing resumes
pathTracer.dynamicLowRes = true;    // trace at low res first, then full res
pathTracer.fadeDuration = 300;      // fade the traced image in over the raster one
pathTracer.tiles.set(2, 2);         // render in tiles to keep the main thread responsive
```

The render loop then just calls `renderSample()` every frame and `updateCamera()` on camera change; the library handles the raster/trace crossfade. Tiling matters at full resolution — a single untiled sample on a large canvas can blow a frame budget and make the tab feel frozen.

### Scene updates are expensive

`setScene()` rebuilds the BVH and repacks all textures. That's fine for "configure scene → render", but not per-frame. In an app where users edit the scene:

- Material/uniform-level changes are cheap: `updateMaterials()` / `updateEnvironment()` keep the BVH.
- Geometry/topology changes require a rebuild. For large scenes, do it off the main thread: `pathTracer.setBVHWorker(new ParallelMeshBVHWorker())` (from `three-mesh-bvh/worker`) + `setSceneAsync()`. The lab uses the synchronous path because the helmet builds in well under a second.

### Convergence and denoising

Progressive accumulation means clean output takes hundreds of samples. Practical levers:

- **Sample cap + UI feedback**: expose `pathTracer.samples` (the lab shows samples + elapsed time). Users tolerate waiting when they can see progress.
- **`filterGlossyFactor`** (~0.5): blurs caustic-ish glossy paths slightly to kill fireflies at a small quality cost.
- **`renderScale`**: converge at 0.5× for previews, 1× for finals.
- **AI denoising**: the "AI denoise" checkbox runs [oidn-web](https://github.com/pissang/oidn-web) (Intel Open Image Denoise via tfjs/WebGPU — WebGPU-only). Implementation: the tone-mapped canvas is captured and denoised on a doubling schedule (4, 8, 16, … samples, plus a final pass at the sample cap), with the result drawn to a 2D overlay canvas that fades in over the live render; any accumulation reset hides it. `oidn-web` is dynamically imported on first enable (it pulls in tfjs); weights live in `pt-lab/assets/` (`rt_ldr.tza`, `rt_ldr_alb_nrm.tza` — Git LFS files in their source repos, fetch via the LFS media endpoint or batch API, not `raw.githubusercontent.com`).

### Fixed-size PNG export

`exportPNG()` exports at a chosen square resolution (64²–1024², from the Export size dropdown), independent of the viewport/display. `exportPNG()` temporarily resizes the renderer to `size × size` at pixel-ratio 1 with a square camera, converges to a fixed sample count (the render loop yields to it so the button can show progress), captures, and restores the interactive view. It's a genuine native-resolution render, not a resample. Two gotchas it handles: the WebGL drawing buffer isn't preserved across composites, so the final sample is drawn and captured in the **same synchronous tick** (an intervening animation frame blanks it); and all renderer/camera state is saved and restored around the export.

If AI denoise is on, the export is denoised too: it snapshots the color `ImageData` (plus albedo/normal aux buffers at the render resolution when aux is enabled), `await`s the UNet to load, runs it, and writes the denoised result. Convergence maps to 0–85% of the progress bar and denoising to 85–100%. It falls back to a raw export (with a console warning) if WebGPU is missing or aux capture fails.

Two size subtleties in the denoise path: OIDN pads any input smaller than its tile size (256 for these weights) and the garbage padding bleeds into the image through the UNet's receptive field — wrecking small denoised exports. So when denoising, the scene is rendered and denoised at `max(size, 256)` and then downscaled to the requested size (`DENOISE_MIN_SIZE`). And the aux buffers must be captured with the tile scissor test disabled, or the path tracer's leftover tile clip leaves parts of them at the clear color.
- **Auxiliary buffers** ("Albedo/normal aux" checkbox, on by default): alongside the noisy color, the denoiser receives two noise-free guide images rendered from the scene — a per-mesh unlit base-color pass (albedo; materials temporarily swapped for `MeshBasicMaterial` mirrors, background white per OIDN convention) and a packed view-space normal pass (`scene.overrideMaterial = MeshNormalMaterial`, background 0x808080 = zero normal). These act as an edge map, so low-sample denoised images keep silhouettes and material boundaries crisp instead of smearing them. Captured once per accumulation cycle into `WebGLRenderTarget`s (albedo target uses an sRGB texture so readback matches the color capture; rows are flipped since GL reads bottom-up), cached until the next reset. Aux and color-only UNets are incompatible, so both are kept and lazily loaded; if aux weights or capture fail, it falls back to color-only with a console warning. Known simplifications: normal maps are lost under the override material, and emissive-only surfaces (the room lamp) get black albedo. Denoising tone-mapped LDR remains off-spec (OIDN prefers linear HDR) but works well in practice.

### Color-space tagging

`canvas.toBlob()` writes an untagged PNG — IHDR/IDAT/IEND and nothing else, no color chunks at all — which leaves every reader to guess the transfer function. The beauty exports are ACES tone-mapped and sRGB-encoded (the renderer's default `outputColorSpace`), so they say so: `tagSRGB()` splices an **sRGB** chunk plus the **gAMA** (45455) and **cHRM** (sRGB primaries, D65) pair the spec wants written alongside it into the blob after IHDR, CRCs and all. It skips chunks the encoder already wrote and stands down entirely if an `iCCP` or `cICP` is present, so it's idempotent and never fights a color-managed file.

The dataset passes below are deliberately left **untagged**: they hold raw linear code values (packed depth, normalized positions), not color, and a color tag would invite a decoder to convert them. Load them with `NoColorSpace` in three.js — the `Texture` default, so a plain `TextureLoader` is already correct — and never set `SRGBColorSpace` on them.

### Dataset exports (G-buffer ground truth for world-lab)

Beyond the beauty PNG, the library can export ground-truth passes for grading vision experiments in
`../world-lab-workspace` — these are raster-only override-material passes (instant, never path
traced), following the same capture pattern as the denoiser's aux buffers:

- **Rotation-series export** (`exportRotationSeries`): rotates a selected object through an angle
  range and saves a path-traced beauty + an **object-space-position** pass per angle
  (`<base>-ryNNN.png` / `-pos.png`). The position pass encodes each fragment's local vertex position
  normalized to the object bbox — the same surface point keeps the same RGB under any rotation — so
  it's a correspondence oracle for grading feature matchers (world-lab Demo 8). The matcher itself
  must only ever see the RGB frames.
- **Depth-pass export** (`exportDepthPass`): saves the current view's **forward depth** (camera-space
  −z, the convention world-lab's plane sweep uses) for the whole scene, packed 24-bit into RGB with
  the standard fract ladder (alpha = coverage), max depth in the filename:
  `<base>-x<X>-y<Y>-z<Z>-depth<max>.png` (decode `depth = (R/255 + G/65025 + B/16581375) × max`).
  Position-in-filename matches the multi-view convention Demos 6/7 parse, so a depth pass pairs
  automatically with a beauty export of the same view and grades Demo 7's dense reconstruction.

- **AOV set** (`exportAOVs`): saves depth, normal and albedo for the current view in one call —
  `<base>-depth.png`, `-normal.png`, `-albedo.png` — and **returns** `maxDepth` alongside the file
  names rather than only baking it into one, because parsing a float back out of a filename is a
  thing that breaks. Same passes, same encodings and same untagged policy as the two above; the
  normal and albedo captures are the denoiser's own aux buffers, reused. The set decomposes *why*
  an edge is in a picture: a depth step is an occlusion, a normal step with no depth step is a
  crease, an albedo step with neither is texture, and an edge with none of the three belongs to the
  lighting rather than to the object.
- **Projected geometry** (`groundTruthGeometry`): returns — as plain data, never three.js objects —
  every mesh edge that is a **silhouette**, a **crease** or a mesh **boundary**, projected into
  image space, with the fraction of it that is actually visible measured against the depth pass,
  plus the vertices those edges meet at. This is the pass that answers "is the corner a detector
  reported a real one", which no raster pass can: a corner is a *point*, and extracting points from
  an edge image is itself the problem under test.

  Three limits are worth stating rather than discovering. A **geometric edge need not be a visible
  one** — two faces meeting under flat lighting produce no gradient. A **visible edge need not be
  geometric** — shadow boundaries and specular terminators are real image edges and are not here.
  And **visibility is rasterised**, so it is right to about a pixel; `gtVisibleAt` documents the
  tolerance and the measurement behind it. `creaseAngle` matters: at 1° a smooth sphere yields every
  one of its facet boundaries, at 20° it correctly yields none and keeps only its silhouette.

  Edges are keyed by position across the whole scene rather than per mesh, so a floor and the wall
  standing on it share the entry their common edge sits at and the dihedral between them comes out
  as the 90° it really is.

cv-lab's generator uses the AOV set and the projected geometry; the rotation series and the lone
depth pass predate it and are kept for world-lab.

### Other production caveats

- **Material coverage**: `MeshPhysicalMaterial` is the well-supported path (transmission, clearcoat, sheen, iridescence). Custom `ShaderMaterial`s won't translate — the path tracer has its own material model.
- **Bundle size**: three + pathtracer is ~875 kB minified (~233 kB gzip). In the larger app, lazy-load the whole rendering module (`import('./pathtracer')`) so it doesn't sit in the critical path.
- **Mobile / weak GPUs**: fragment-shader path tracing is heavy and some mobile GPUs hit precision/timeout issues. Feature-detect WebGL2 float-texture support and consider gating the feature or defaulting to raster on mobile.
- **Context loss**: long GPU-heavy sessions can lose the WebGL context (especially when tabbed away). Listen for `webglcontextlost`/`webglcontextrestored` on the canvas and rebuild.
- **Maintenance status**: `three-gpu-pathtracer` is stable and widely used, but development has slowed (0.0.24, Feb 2026). Treat it as a mature-but-quiet dependency: pin versions, keep the abstraction boundary, and watch the WebGPU ecosystem as the eventual successor.

## Building and checking

From the repository root:

```sh
npm run build:generate   # compile pt-lab, both pages and the assets into dist-generate/
npm run check:pt-lab     # type-check pt-lab -- Vite strips types without checking them
```

`build:generate` ends by checking that every pt-lab method the pages call is defined in what it built (`scripts/check-generate-bundle.js`): the pages are plain JavaScript and Svelte, so nothing else would notice a renamed one. In the app, **Panes → Scene Editor…** composes a scene and **Panes → Generate Images…** renders it.
