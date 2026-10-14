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

A cell that commands its own sweeps can leave the glue to the package. Each
frame's rows, numbered a view at a time (`numberByView`), go to `carryPlan`
with the still edge pooled across the sweeps (`poolCandidates`); the sweeps'
carried rows then calibrate, and each later frame solves, as solve-position
does it -- the carried readings, weighed by 1/gapSigma²:

```js
import { calibrateCell, solveCell } from '@cv-lab/vision';

const calibration = calibrateCell({ sweeps: { x: { rows, axis: [1, 0, 0] }, y: ..., z: ..., turn: { rows } },
  mode: 'hinged' });
const { d, refused } = solveCell(calibration, frameRows);   // [x, y, z mm, turn deg] from the reference
```

The still part may be a fixture built from several objects. A pocket is a
plate and four walls, and `gapRows`' `target` may be all their names. The
pairs are then chosen among every wall's edges at once: each edge takes its
nearest, and no pair may be far wider than the closest. Taken wall by wall, a
wall with no close pair keeps a far one.

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

For parts that are CAD exports, pass `join: true`. An exporter splits a box's
edge into collinear pieces, and each piece would be its own edge, too short to
pair; joined, a split box gives the plain box's edges exactly. And a filleted
edge, its fold spread over facets each softer than `creaseAngle`, has no edge
at all unless the band of facets is read as one: with `join`, a band that
turns more than `creaseAngle` and projects no wider than 6 px is a crease
along its middle (`rounded`: its width in pixels). It is found and paired;
where the image's edge falls inside the band is shading's, and can be a
pixel or more from the middle, so read such a gap through a calibration.
Off by default, so the edges are exactly a renderer's extraction's.

## Where no gap can be seen

A gap is read between two parts. Down inside a pocket the walls hide every
pair, and what is left in sight is the moving part's own outline. `fitEdges`
places each lone segment as one step against the unblurred image (as steady
as a gap: within 0.06 px, spread 0.01-0.035, on the stack), and `edgeRows`
reads the moving part's lone edges, each against an anchor fixed the first
time its view sees it, as rows `calibrateCell` and `solveCell` take beside
gaps:

```js
// statements: ... 'E = fitEdges(F, G)'
const { rows, anchors } = edgeRows({ truth, matches, edges }, 'block', anchorsSoFar);
```

Keep each view's anchors for the cell's life: a reading is the edge's
distance from its anchor, so the anchor must not move. Nor must the camera:
unlike a gap's two edges, a lone edge moves with it.

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
- `test/conformance/`: the case a host checks itself against -- a real
  frame, the statements a frame goes through, each one's hash. cv-lab holds
  the addon and the module to it on every runner (`test/conformance.js`); rr
  runs it in Chrome through its own build (`tests/vision-conformance.spec.ts`).
  When an operation's output changes on purpose, write it again with
  `scripts/conformance.js` (its `case.json` records the frame, crop and
  carried commands it came from) and commit it with the change.
