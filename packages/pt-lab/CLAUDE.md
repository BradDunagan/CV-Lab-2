# pt-lab/

The path tracer and scene editor behind cv-lab's image generation. `README.md`
here is the real documentation — architecture, the rooms, edit-mode shadows,
the export passes and their encodings. Keep it in sync with meaningful changes.

It moved into this repository from [BradDunagan/pt-lab](https://github.com/BradDunagan/pt-lab)
at `29b9957`; history before that is there.

## Shape

```
package.json                  @cv-lab/pt-lab; three & co. as peerDependencies
src/index.ts                  the barrel — what `import … from '@cv-lab/pt-lab'` resolves to
src/lib/pathtracer.ts         the core: PathTracerLab, framework-agnostic
src/lib/*.svelte              the viewer and the inspector panels
src/assets/imports/           bundled importable .glb files, found by import.meta.glob
assets/                       default model, HDR, denoiser weights — fetched by URL,
                              copied into dist-generate/assets/ by the build
```

In cv-lab the consumers are in `src/generate/`: `main.js` (the generator's
page) and `Editor.svelte` (the Scene Editor's view and its `__editor` API —
its controls are a paneless column in the app window). Nothing in
`src/renderer/` may import it — the app window never hosts the tracer.

rr takes the package from source (`"../cv-lab-2/packages/pt-lab"`), and its
analysis camera renders with `renderFrame`. rr's `tests/analysis-camera.spec.ts`
renders the conformance case's shot and must read cv-lab's gaps to within
render noise, so a change here that moves a render is seen there too.

## Commands (from the repository root)

```bash
npm run build:generate   # compile it; ends by checking every called method is defined
npm run check:pt-lab     # svelte-check — the build strips types without checking them
```

There are no unit tests for pt-lab itself; `test/groundtruth.js` checks the
seams (SceneData fields forwarded, bundle defines what the pages call), and the
Scene Editor and generator are checked by driving them.

## Boundaries worth keeping

- **No three.js types cross into Svelte or into cv-lab.** Hosts talk to
  `PathTracerLab` through plain-data methods and callbacks (`listObjects`,
  `setObjectMaterial`, `setLight`, `serializeScene`, `applyScene`, `importGLB`,
  `registerImport`, `onObjectsChanged`, `onLightsChanged`), so the backend can
  move to WebGPU later.
- **Progressive accumulation.** `renderSample()` runs every frame and
  accumulates; any camera/material/environment change must reset or update
  (`reset()`, `updateCamera()`, `updateMaterials()`, `updateEnvironment()`).
  `setScene()` rebuilds the BVH and repacks textures — never per frame.
- **Two render modes.** Edit mode is a raster pass with shadow-map proxies for
  lamps that cannot cast one; `syncRasterLights()` owns hiding those proxies and
  must run before any tracer sync, because the tracer collects visible lights.
- **`registerImport` never touches IndexedDB**, and refuses a key already in
  the library. A host that persisted what it rendered would render differently
  on its next start.
- **Ground truth is plain data.** `groundTruthGeometry` and `exportAOVs` feed
  cv-lab's scoring; a change to their encodings changes every number downstream
  and needs the same scrutiny as a kernel change.

## Version coupling

`three-gpu-pathtracer` reaches into three.js internals. The known-good pairing
is `three@0.185` + `three-gpu-pathtracer@0.0.24` (+ `three-mesh-bvh@0.9.13`,
pinned exactly in package.json); don't bump any of them without re-rendering
and re-scoring. The package's peerDependencies say the same, and rr is on
the same versions (it moved from three 0.183 for this). Only `MeshPhysicalMaterial` translates well to the path tracer.
