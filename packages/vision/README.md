# @cv-lab/vision

cv-lab's measurement library, as a package: images in, described geometry out,
and from the geometry where a part is, reproducibly. It is developed and
measured in cv-lab, against a renderer's ground truth; rr (in a browser) and
rr-desktop (under Electron) consume it as it is.

ES modules, no Node built-ins, no global state. Types are in `types/`. The C
kernels come as `wasm/cvlab.wasm`: 72 KB, importing nothing.

## Using it

```js
import { loadWasm, createRegistry, Session } from '@cv-lab/vision';

const backend = await loadWasm(new URL('@cv-lab/vision/cvlab.wasm', import.meta.url));
const registry = createRegistry({ backend, readFrame, readTextFile });
const session = new Session({ registry, environment: { app: 'rr', backend: backend.backend, build: backend.build } });
await session.run(`
A = frame("capture-0042")
G = gray(A)
B = gaussian(G, sigma=1.4)
`);
const log = session.toJSON();   // every entry with its inputs' and output's hashes
```

The host supplies, and the package touches nothing else:

| | |
|---|---|
| `backend` | the C kernels: `loadWasm(bytes \| URL \| Response)`. In cv-lab, the Node-API addon gives the same results to the bit |
| `readFrame(source)` | for `frame`: linear float, `{ width, height, channels: 3 \| 4, data: Float32Array }`, rows top-down |
| `decodeFile(path)` | for `load`: 8-bit RGBA, `{ width, height, pixels }` |
| `readTextFile(path)` | for `load(curve=)` and `groundTruth` |

Run it in a Web Worker: a kernel is synchronous and the module has one thread.

## The input: linear float frames

`frame()` is the route in. A frame is light as the renderer computed it -- a
path tracer's float render target read back, times the exposure -- never
tone-mapped, clipped or rounded to 8 bits, so nothing has to be undone. NaN,
infinity, negative samples and one-channel frames are refused, not repaired:
which repair is right is the host's decision, made where it can be recorded.
`source` is whatever the host knows the frame by; the frame's hash goes in the
log, so a replay handed a different frame says so. `decodePfm` and `encodePfm`
read and write the same thing as a file, which is how cv-lab keeps them.

`load` is still there for 8-bit images: a real camera's, or anything else
already encoded. It needs a decoder (in a browser, `createImageBitmap` and a
canvas give the RGBA), and the encoding stated (`from=`, `as=`) or a measured
response curve (`curve=`).

## From readings to a pose

A cell calibrates once, from sweeps it commanded, with no truth anywhere, and
then estimates every frame against the last pose carried forward by the move
it commanded:

```js
import { calibrateReadings, estimatePose, frameReadings, pairAngles, carryForward } from '@cv-lab/vision';

const calibrated = calibrateReadings({ sweepFrames, unknowns: ['x', 'y', 'z', 'turn'], mode: 'hinged',
  pick: (r) => r.tracked ?? r.refit ?? r.detected });
const calibration = { calibrated: [...calibrated.values()], medianSigma };
const angles = pairAngles(calibrationRows);

const { solution } = estimatePose(calibration, frameReadings(rows, angles), carryForward(last, move, motionVariance));
```

`sweepFrames` are the calibration frames' gap readings (`gapRows`) with the
step each was commanded at. cv-lab's `scripts/solve-position.js` and
`scripts/servo.js` are worked examples, and `design-lab-model.md` §5 says
what each choice cost or bought.

## Which edge is which part

Reading a gap needs to know which detected edge is the moving part's, which
the still one's, and where along the pair to read. `predictEdges` says, from
where the parts are believed to be: each part's triangles (in its own frame,
nine numbers each) and pose, and the camera, in; the silhouettes, creases and
boundaries that view shows, with what is hidden taken out, out -- as the
document `groundTruth` reads, so it is a slot like any other truth:

```js
import { predictEdges } from '@cv-lab/vision';

const doc = predictEdges({
  objects: [{ name: 'base', triangles: baseTris, pose: { position: [0, 0.8, 0] } },
            { name: 'part', triangles: partTris, pose: believedPose }],   // rotation in degrees, x then y then z
  camera: { position, target, fov: 50 },                                    // vertical fov; up is +y
  size: 512,
});
```

About 3 ms a view for two cubes on a table in a room, against about 20 s for
a renderer's depth-pass extraction, and the same edges to within 10⁻¹² px.
Visibility is exact; for identifying from a belief, pass `margin: 1.5`, so an
edge the belief hides by less than a pixel and a half, which may be in plain
view, still counts (cv-lab's `design-lab-model.md` §5, "A forty-first").

## Reproducibility

Every result has a content hash, and a session's log replays to the same
hashes. That holds across hosts because:

- the kernels are the same C, as WebAssembly in every engine, and cv-lab's
  `test/determinism.js` holds the module and the native addon to the same
  pinned hashes on macOS, Linux and Windows;
- buffers are hashed in C (`bufferHash`), and records with the package's own
  SHA-256, never an engine's;
- the module carries its own math library, so `exp` and `pow` do not depend
  on the browser;
- the JavaScript uses the package's own math (`src/math.js`), never the
  engine's `Math.sin`, `atan2`, `log` or `hypot`: engines disagree on those
  in the last bit -- Chrome's V8 and Node's on 3-18% of inputs -- and
  `math.js` is built from `+ - * /` and `sqrt` alone, which the language
  fixes. `npm run bench` gives the same hash for every statement in Node,
  Chrome and Firefox.

A host should record `backend.build` (the module's SHA-256) in each session,
and keep the frames it measured, or their hashes: a path-traced frame is not
guaranteed to re-render bit-identically.

## Maintaining it (in cv-lab)

- `npm run build:wasm`: rebuild the module after any change to `native/*.c`;
  commit it. CI rebuilds it on Linux and requires the same bytes.
- `npm run build:types`: regenerate `types/` after a JSDoc change; commit
  them. `--check` also compiles a TypeScript host against them.
- `test/package.js`: bundles the package for a browser, and runs it in a bare
  context from the module's bytes against the addon's hashes.
