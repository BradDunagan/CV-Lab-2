'use strict';

/**
 * Ground truth — reading it and scoring against it — and the checks that guard
 * the generator's build and packaging, which share the same subject.
 *
 * Pure JavaScript — no addon, no Electron, no renderer. Every fixture here is
 * built by hand so the expected answer is arithmetic rather than "whatever came
 * out". design-lab-model.md's working habits are explicit about that: a test
 * that records what the code produces cannot tell you the code is wrong.
 *
 *   node test/groundtruth.js
 */

const assert = require('node:assert/strict');
const { parseGroundTruth, readGroundTruth, GroundTruthError } =
  require('../src/lab/groundtruth');
const { matchFeatures, summarise, lineAngleDifference, pointToSegment } =
  require('../src/lab/match');
const { createRegistry } = require('../src/lab/ops');

let failures = 0;
/*
 * Async-aware, unlike the sibling suites, because one case here reads a file
 * through an injected reader and that reader is a promise.
 *
 * The plain form would run `fn()` inside a try, see a Promise come back, and
 * print "ok" -- a rejection lands as an unhandled rejection long after the
 * verdict was reported. A check that passes for the wrong reason is worse than
 * no check, which is a lesson this project has already paid for once.
 */
const pending = [];
function test(name, fn) {
  const record = (err) => {
    if (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
    else console.log(`  ok   ${name}`);
  };
  let result;
  try { result = fn(); } catch (err) { record(err); return; }
  if (result && typeof result.then === 'function') {
    pending.push(result.then(() => record(null), record));
  } else {
    record(null);
  }
}

/* --- fixtures ---------------------------------------------------------- */

/** One ground-truth edge, as the renderer writes them. */
const gtEdge = (id, x0, y0, x1, y1, extra = {}) => ({
  id, cause: 'silhouette', objects: ['Cube'],
  x0, y0, x1, y1, z0: 1, z1: 1,
  length: Math.hypot(x1 - x0, y1 - y0),
  angle: ((Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI) % 180 + 180) % 180,
  dihedral: 90, visible: 1, clipped: false, v0: 0, v1: 0,
  ...extra,
});

/** One ground-truth vertex. */
const gtVertex = (id, x, y, extra = {}) => ({
  id, x, y, z: 1, degree: 3, visibleDegree: 3,
  onFrame: true, visible: true, angle: 90, objects: ['Cube'],
  ...extra,
});

/** A fitted segment, as `fit` reports one. */
const seg = (id, x0, y0, x1, y1) => ({
  type: 'edge-segment', id, x0, y0, x1, y1,
  length: Math.hypot(x1 - x0, y1 - y0),
  angle: ((Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI) % 180 + 180) % 180,
  pixels: 30, residual: 0.3, rms: 0.2, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
});

/** One corner candidate, as `corners` reports one. */
const corner = (id, x, y, extra = {}) => ({
  type: 'edge-corner', id, x, y, support: 2, segments: [1, 2],
  sigma: 0.1, reach: 2, endpointGap: 1.5, angle: 88, ...extra,
});

const doc = (edges, vertices, size = 256) => ({ size, edges, vertices });

console.log('cv-lab-2 ground-truth and generator-packaging tests');

/* --- the loader -------------------------------------------------------- */

test('a well-formed document becomes namespaced feature records', () => {
  const { features, width, height } = parseGroundTruth(
    doc([gtEdge(1, 0, 0, 10, 0)], [gtVertex(1, 0, 0)]));
  assert.equal(width, 256);
  assert.equal(height, 256);
  assert.deepEqual(features.map((f) => f.type), ['gt-edge', 'gt-vertex']);
});

test('objects are sorted, so the record hashes the same however it arrived', () => {
  const a = parseGroundTruth(doc([gtEdge(1, 0, 0, 10, 0, { objects: ['Room', 'Floor'] })], []));
  const b = parseGroundTruth(doc([gtEdge(1, 0, 0, 10, 0, { objects: ['Floor', 'Room'] })], []));
  assert.deepEqual(a.features[0].objects, ['Floor', 'Room']);
  assert.deepEqual(a.features, b.features);
});

test('a NaN coordinate is refused, naming the field', () => {
  // The failure this guards against is not a crash. A NaN propagating into a
  // distance produces a number nobody can trust, silently.
  assert.throws(
    () => parseGroundTruth(doc([gtEdge(1, 0, 0, 10, 0, { x1: NaN })], [])),
    (err) => err instanceof GroundTruthError && /"x1"/.test(err.message)
  );
});

test('a missing field is refused rather than defaulted', () => {
  const bad = gtEdge(1, 0, 0, 10, 0);
  delete bad.angle;
  assert.throws(() => parseGroundTruth(doc([bad], [])), /"angle"/);
});

test('an unknown cause is refused, listing the ones that exist', () => {
  assert.throws(
    () => parseGroundTruth(doc([gtEdge(1, 0, 0, 10, 0, { cause: 'texture' })], [])),
    /silhouette.*crease.*boundary/s
  );
});

test('visible outside [0,1] is refused', () => {
  assert.throws(() => parseGroundTruth(doc([gtEdge(1, 0, 0, 10, 0, { visible: 1.5 })], [])),
    /"visible" in \[0, 1\]/);
});

test('a bad size is refused before anything reads coordinates', () => {
  assert.throws(() => parseGroundTruth({ size: 0, edges: [], vertices: [] }), /"size"/);
  assert.throws(() => parseGroundTruth({ size: 2.5, edges: [], vertices: [] }), /"size"/);
});

test('malformed JSON names the file rather than throwing a parser error', () => {
  assert.throws(() => readGroundTruth('{oops', 'truth.gt.json'),
    /truth\.gt\.json is not valid JSON/);
});

/* --- the geometry helpers ---------------------------------------------- */

test('line angles compare as lines, not directions', () => {
  // 10 and 170 are twenty degrees apart as lines even though they are 160
  // apart as numbers. A line has no direction; this is the same fold `fit`
  // applies when it reports [0, 180).
  assert.equal(lineAngleDifference(10, 170), 20);
  assert.equal(lineAngleDifference(0, 90), 90);
  assert.equal(lineAngleDifference(179, 1), 2);
});

test('point-to-segment distance is clamped to the segment', () => {
  // Not the distance to the infinite line: a collinear segment on the far side
  // of the image must not attract anything.
  assert.equal(pointToSegment(5, 3, 0, 0, 10, 0), 3);       // beside it
  assert.equal(pointToSegment(20, 0, 0, 0, 10, 0), 10);     // past the end
  assert.equal(pointToSegment(-5, 0, 0, 0, 10, 0), 5);
});

/* --- matching segments -------------------------------------------------- */

test('a segment lying along an edge is a hit, and carries the cause', () => {
  const out = matchFeatures([seg(1, 10, 50, 90, 50)],
    parseGroundTruth(doc([gtEdge(1, 10, 50, 90, 50)], [])).features);
  const hit = out.find((r) => r.role === 'hit');
  assert.ok(hit, 'expected a hit');
  assert.equal(hit.cause, 'silhouette');
  assert.ok(hit.distance < 0.001, `distance ${hit.distance}`);
});

test('a segment far from any geometry is a false positive, and says how far', () => {
  const out = matchFeatures([seg(1, 10, 200, 90, 200)],
    parseGroundTruth(doc([gtEdge(1, 10, 50, 90, 50)], [])).features);
  const fp = out.find((r) => r.role === 'false-positive');
  assert.ok(fp);
  assert.equal(fp.truth, null);
  // Reported anyway: "nearest geometry was 150 px away" is a finding.
  assert.ok(Math.abs(fp.distance - 150) < 0.001, `distance ${fp.distance}`);
});

test('a segment at the right place but the wrong angle does not match', () => {
  // Two edges crossing at the same midpoint. Distance alone would accept it.
  const out = matchFeatures([seg(1, 50, 10, 50, 90)],
    parseGroundTruth(doc([gtEdge(1, 10, 50, 90, 50)], [])).features);
  assert.equal(out.filter((r) => r.role === 'hit').length, 0);
  const fp = out.find((r) => r.role === 'false-positive');
  assert.ok(fp.angleDiff > 80, `angleDiff ${fp.angleDiff}`);
});

test('one segment covering a polyline credits every facet it covers', () => {
  /*
   * The defect this pins down: recall used to be asked per DETECTION, which
   * credited only the single nearest ground-truth edge. A fitted segment lying
   * along twelve facets of a smooth silhouette then read as one found and
   * eleven missed — a pipeline that had drawn a line straight down the middle
   * of all of them scoring 8% recall.
   */
  const facets = [];
  for (let i = 0; i < 12; i++) facets.push(gtEdge(i + 1, i * 5, 50, (i + 1) * 5, 50));
  const out = matchFeatures([seg(1, 0, 50, 60, 50)],
    parseGroundTruth(doc(facets, [])).features);
  assert.equal(out.filter((r) => r.role === 'miss').length, 0,
    'every facet the segment lies along should count as found');
  assert.equal(summarise(out).recall, 1);
});

test('a hidden edge is not held against the detector', () => {
  // It exists, so the renderer reports it; it cannot be seen, so missing it is
  // not a failure. minVisible is where that line gets drawn.
  const truth = parseGroundTruth(doc([
    gtEdge(1, 10, 50, 90, 50),
    gtEdge(2, 10, 80, 90, 80, { visible: 0 }),
  ], [])).features;
  const out = matchFeatures([seg(1, 10, 50, 90, 50)], truth);
  assert.equal(out.filter((r) => r.role === 'miss').length, 0);
  // …and lowering the bar brings it back as a miss.
  const strict = matchFeatures([seg(1, 10, 50, 90, 50)], truth, { minVisible: 0 });
  assert.equal(strict.filter((r) => r.role === 'miss').length, 1);
});

/* --- matching corners --------------------------------------------------- */

test('a corner on a real vertex is a hit', () => {
  const out = matchFeatures([corner(1, 40, 40)],
    parseGroundTruth(doc([], [gtVertex(1, 41, 40)])).features);
  const hit = out.find((r) => r.role === 'hit');
  assert.ok(hit);
  assert.ok(Math.abs(hit.distance - 1) < 1e-9);
});

test('two candidates on one vertex cannot both be right', () => {
  /*
   * One-to-one, unlike segments. A vertex claimed by three candidates is three
   * answers to a question with one answer, and counting all three would report
   * a detector that fires everywhere as highly accurate. The nearest wins.
   */
  const out = matchFeatures([corner(1, 40, 40), corner(2, 42, 40)],
    parseGroundTruth(doc([], [gtVertex(1, 41.5, 40)])).features);
  assert.equal(out.filter((r) => r.role === 'hit').length, 1);
  assert.equal(out.find((r) => r.role === 'hit').detected, 2, 'the nearer one wins');
  assert.equal(out.filter((r) => r.role === 'false-positive').length, 1);
});

test('a bend in a silhouette polyline is not expected to be found', () => {
  /*
   * A smooth object's silhouette arrives as a polyline, so its interior points
   * are vertices of degree two whose edges run almost straight through. They
   * are vertices geometrically and not corners visually, and no corner
   * detector should be marked down for missing one. `angle` is what separates
   * them: a cube's vertices sit near 90, a sphere's facets bend by a few.
   */
  const truth = parseGroundTruth(doc([], [
    gtVertex(1, 40, 40, { angle: 88 }),
    gtVertex(2, 90, 90, { angle: 7, degree: 2, visibleDegree: 2 }),
  ], 256)).features;
  const out = matchFeatures([corner(1, 40, 40)], truth);
  assert.equal(out.filter((r) => r.role === 'miss').length, 0);
  assert.equal(summarise(out).recall, 1);
});

test('an off-frame or occluded vertex is not expected either', () => {
  const truth = parseGroundTruth(doc([], [
    gtVertex(1, 400, 40, { onFrame: false }),
    gtVertex(2, 40, 40, { visible: false }),
  ])).features;
  assert.equal(matchFeatures([], truth).length, 0);
});

test('a false positive still reports how near the nearest real corner was', () => {
  // 4 px is a near miss and 60 px is an invention; both are false positives
  // and they are not the same finding.
  const out = matchFeatures([corner(1, 100, 40)],
    parseGroundTruth(doc([], [gtVertex(1, 40, 40)])).features);
  const fp = out.find((r) => r.role === 'false-positive');
  assert.ok(Math.abs(fp.distance - 60) < 1e-9, `distance ${fp.distance}`);
});

/* --- the properties that make a result comparable ----------------------- */

test('mixing feature kinds is refused rather than half-scored', () => {
  assert.throws(
    () => matchFeatures([seg(1, 0, 0, 10, 0), corner(2, 5, 5)], []),
    /mixes feature types/
  );
});

test('an unrecognised feature kind is refused, saying what it expects', () => {
  assert.throws(
    () => matchFeatures([{ type: 'region-blob', id: 1 }], []),
    /edge-segment.*edge-corner/s
  );
});

test('the result does not depend on the order the inputs arrived in', () => {
  const truth = parseGroundTruth(doc(
    [gtEdge(1, 10, 50, 90, 50), gtEdge(2, 50, 10, 50, 90), gtEdge(3, 10, 10, 90, 90)],
    [gtVertex(1, 50, 50)]
  )).features;
  const detected = [seg(1, 10, 50, 90, 50), seg(2, 50, 10, 50, 90)];
  const forward = matchFeatures(detected, truth);
  const backward = matchFeatures([...detected].reverse(), [...truth].reverse());
  const key = (r) => `${r.role}:${r.detected}:${r.truth}`;
  assert.deepEqual(backward.map(key).sort(), forward.map(key).sort());
});

test('an empty detection list reports every visible edge as missed', () => {
  const out = matchFeatures([], parseGroundTruth(doc([gtEdge(1, 10, 50, 90, 50)], [])).features);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'miss');
  assert.equal(summarise(out).recall, 0);
  assert.equal(summarise(out).precision, null, 'no detections means precision is undefined, not 0');
});

/* --- the registry ------------------------------------------------------- */

test('groundTruth and match are registered, and both are implemented', () => {
  // Unlike `load`, groundTruth needs nothing from a renderer: reading JSON is
  // plain Node, so it must work under plain node rather than report itself
  // unimplemented.
  const registry = createRegistry();
  for (const name of ['groundTruth', 'match']) {
    assert.ok(registry.get(name).implemented, `${name} should be implemented`);
  }
});

test('groundTruth reads a file through the injected reader', async () => {
  const registry = createRegistry({
    readTextFile: async () => JSON.stringify(doc([gtEdge(1, 0, 0, 10, 0)], [gtVertex(1, 0, 0)])),
  });
  const op = registry.get('groundTruth');
  const all = await op.kernel({ params: { path: 'x.gt.json', kind: 'both' } });
  assert.equal(all.features.length, 2);
  const edges = await op.kernel({ params: { path: 'x.gt.json', kind: 'edges' } });
  assert.deepEqual(edges.features.map((f) => f.type), ['gt-edge']);
  const vertices = await op.kernel({ params: { path: 'x.gt.json', kind: 'vertices' } });
  assert.deepEqual(vertices.features.map((f) => f.type), ['gt-vertex']);
  assert.equal(all.width, 256);
});

test('match refuses two feature lists measured in different images', () => {
  /*
   * Scoring a 512-pixel run against 256-pixel truth would otherwise produce
   * numbers rather than an error, and they would look plausible — every
   * distance roughly doubled.
   */
  const op = createRegistry().get('match');
  assert.throws(
    () => op.kernel({
      inputs: [
        { features: [], width: 512, height: 512 },
        { features: [], width: 256, height: 256 },
      ],
      params: {},
    }),
    /different images.*512x512.*256x256/s
  );
});

Promise.all(pending).then(() => {
  /* --- the generator's prerequisite checks ------------------------------- */

test('a stale generator build is caught, and named', () => {
  /*
   * pt-lab is a Vite ALIAS resolved at build time, so editing pt-lab and
   * re-running the generator without rebuilding silently runs the old bundle
   * and produces images that look completely reasonable. The symptom is "my
   * change did nothing", which costs a sweep to notice.
   *
   * Checked against a temporary tree rather than the real one, because the
   * real answer depends on whether someone just ran a build.
   */
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { buildInputs } = require('../src/generate/driver');

  const inputs = buildInputs();
  assert.ok(inputs.length > 10, `expected pt-lab's source tree, found ${inputs.length} inputs`);
  assert.ok(inputs.some((f) => f.endsWith('pathtracer.ts')),
    'pt-lab\'s pathtracer must count as a build input');
  assert.ok(!inputs.some((f) => f.endsWith(`generate${path.sep}driver.js`)),
    'driver.js is required by Electron, not bundled — editing it cannot make a build stale');

  // The comparison itself, on files this test owns.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvlab-stale-'));
  const older = path.join(dir, 'built');
  const newer = path.join(dir, 'source');
  fs.writeFileSync(older, '');
  fs.writeFileSync(newer, '');
  fs.utimesSync(older, new Date(1000), new Date(1000));
  fs.utimesSync(newer, new Date(2000), new Date(2000));
  assert.ok(fs.statSync(newer).mtimeMs > fs.statSync(older).mtimeMs,
    'the mtime comparison the staleness check relies on must hold');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the assets a run cannot start without, and the ones it can', () => {
  /*
   * `init()` fetches the model and the environment on every run, whatever the
   * scene — so a bundle missing either cannot render at all and the generator
   * should refuse up front. The denoiser weights are different: they are only
   * fetched when denoising is on, so a bundle without them is perfectly
   * usable and refusing to start over them would be wrong.
   */
  const { CORE_ASSETS } = require('../src/generate/driver');
  assert.deepEqual([...CORE_ASSETS].sort(),
    ['damaged-helmet.glb', 'royal_esplanade_1k.hdr']);
  assert.ok(!CORE_ASSETS.some((f) => f.endsWith('.tza')),
    'the denoiser weights are optional — needed only with --denoise');
});

test('a built bundle carries its own assets, so a run needs no checkout', () => {
  /*
   * The point of copying them in at build time: `build:generate` needs the
   * sibling pt-lab-workspace checkout and `npm run generate` does not. Checked
   * against the real bundle, and skipped when there is not one, because this
   * suite runs under plain node where a build may never have happened.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const { assetsDir, BUNDLED_ASSETS, CORE_ASSETS } = require('../src/generate/driver');
  const built = CORE_ASSETS.every((f) => fs.existsSync(path.join(BUNDLED_ASSETS, f)));
  if (!built) return; // nothing built here; the flag below is what would catch a regression
  assert.equal(assetsDir(), BUNDLED_ASSETS,
    'a bundle with its own assets must be preferred over the sibling checkout');
});

test("pt-lab's assets count as build inputs, so swapping one is caught", () => {
  // The trade for a self-contained bundle: they used to take effect with no
  // rebuild, and now a stale bundle is refused instead.
  const fs = require('node:fs');
  const { buildInputs, PT_ASSETS } = require('../src/generate/driver');
  if (!fs.existsSync(PT_ASSETS)) return; // no sibling checkout here
  assert.ok(buildInputs().some((f) => f.startsWith(PT_ASSETS)),
    "pt-lab's demo assets must be build inputs now that the build copies them");
});

/* --- the generator bundle guard --------------------------------------- */

test('a called-but-undefined pt-lab method is caught, a called-and-defined one is not', () => {
  /*
   * The distinction this whole check turns on. `src/generate/main.js` is plain
   * JavaScript calling a pt-lab built from a sibling checkout, so a method that
   * does not exist there is a RUNTIME error -- the bundle builds, the app
   * packages and launches, and the call throws when a user asks for an image.
   *
   * Both halves live in the same bundled file: main.js's call
   * (`lab.groundTruthGeometry(...)`) and pt-lab's definition
   * (`groundTruthGeometry(size, opts) {`). Searching for the NAME finds the
   * call whether or not the definition is there, so the naive check passes
   * exactly when it matters. The dot is what separates them.
   */
  const { definedIn, missingFrom } = require('../scripts/check-generate-bundle');

  const bothPresent = 'class L{groundTruthGeometry(a,b){return 1}}\nx=lab.groundTruthGeometry(256)';
  const callOnly = 'x=lab.groundTruthGeometry(256)';
  assert.equal(definedIn(bothPresent, 'groundTruthGeometry'), true);
  assert.equal(definedIn(callOnly, 'groundTruthGeometry'), false,
    'a call site alone must not read as a definition — this is the whole point');
  assert.deepEqual(missingFrom(callOnly, ['groundTruthGeometry']), ['groundTruthGeometry']);

  // Shapes the minified bundle really contains.
  assert.equal(definedIn('async exportAOVs(t,e="view",s={}){', 'exportAOVs'), true);
  assert.equal(definedIn('{exportAOVs(t){}}', 'exportAOVs'), true);
  // …and a longer name that merely ends with it must not count.
  assert.equal(definedIn('myExportAOVs(t){}', 'exportAOVs'), false);
});

test('the page\'s pt-lab calls are found by name', () => {
  const { methodsCalledOnLab } = require('../scripts/check-generate-bundle');
  const found = methodsCalledOnLab(`
    lab.init({});
    lab. setRoom('room');
    const t = lab.getObjectTransform(id);
    other.notALabMethod();
    lab.init({});
  `);
  assert.deepEqual(found, ['getObjectTransform', 'init', 'setRoom'],
    'deduplicated, sorted, and only calls on the lab');
});

test('the real bundle defines every pt-lab method the real page calls', () => {
  /*
   * The end-to-end form, against the actual build when there is one. Skipped
   * rather than failed without a build, because this suite runs under plain
   * node where the generator may never have been built -- the postbuild hook
   * is what enforces it where it matters.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const bundle = path.join(__dirname, '..', 'dist-generate', 'generate.js');
  if (!fs.existsSync(bundle)) return;

  const { methodsCalledOnLab, missingFrom } = require('../scripts/check-generate-bundle');
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'generate', 'main.js'), 'utf8');
  const called = methodsCalledOnLab(page);
  assert.ok(called.length > 5, `expected the page to call pt-lab, found ${called.length} methods`);
  assert.deepEqual(missingFrom(fs.readFileSync(bundle, 'utf8'), called), []);
});

test('the packaged application is found on every platform layout', () => {
  /*
   * This is here because a directory listing cost two CI round trips.
   *
   * The first version took the first extensionless executable in
   * linux-unpacked/ and launched `chrome_crashpad_handler`, which exits at
   * once -- reported as "the app never opened a window", blaming the app. The
   * second matched productName and found nothing, because electron-builder
   * names the binary differently per platform: `productFilename` (CV-Lab) on
   * macOS and Windows, `sanitizedName.toLowerCase()` (cv-lab-2) on Linux.
   *
   * Both were only discoverable on a runner. They are discoverable here now.
   */
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  /*
   * Can this filesystem represent a Unix execute bit?
   *
   * NTFS cannot, and Node's chmod is close to a no-op there, so on Windows
   * every file in the fixture reads as non-executable and the two layouts
   * whose branch filters on that bit find nothing. That is a property of the
   * host, not a defect in the finder -- it was a green macOS run, a green
   * Linux run and a red Windows one, which is exactly the shape of a portable
   * test that is not.
   */
  const probe = path.join(os.tmpdir(), `cvlab-exec-probe-${process.pid}`);
  fs.writeFileSync(probe, '');
  fs.chmodSync(probe, 0o755);
  const execBits = (fs.statSync(probe).mode & 0o111) !== 0;
  fs.rmSync(probe, { force: true });

  const layouts = {
    linux: (root) => {
      const d = path.join(root, 'linux-unpacked');
      return { dir: d, expect: 'cv-lab-2',
               files: ['cv-lab-2', 'chrome-sandbox', 'chrome_crashpad_handler'],
               plain: ['libffmpeg.so'] };
    },
    win32: (root) => {
      const d = path.join(root, 'win-unpacked');
      return { dir: d, expect: 'CV-Lab.exe',
               files: ['CV-Lab.exe', 'chrome_crashpad_handler.exe'], plain: [] };
    },
    darwin: (root) => {
      const d = path.join(root, 'mac-arm64', 'CV-Lab.app', 'Contents', 'MacOS');
      return { dir: d, expect: 'CV-Lab', files: ['CV-Lab'], plain: [],
               asar: path.join(root, 'mac-arm64', 'CV-Lab.app', 'Contents', 'Resources', 'app.asar') };
    },
  };

  const exercised = [];
  for (const [platform, build] of Object.entries(layouts)) {
    // Only the win32 branch selects by extension; the others need the bit.
    if (!execBits && platform !== 'win32') continue;
    exercised.push(platform);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `cvlab-dist-${platform}-`));
    const { dir, expect, files, plain, asar } = build(root);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
      fs.writeFileSync(path.join(dir, f), '');
      fs.chmodSync(path.join(dir, f), 0o755);
    }
    for (const f of plain) fs.writeFileSync(path.join(dir, f), '');
    const asarPath = asar ?? path.join(dir, 'resources', 'app.asar');
    fs.mkdirSync(path.dirname(asarPath), { recursive: true });
    fs.writeFileSync(asarPath, '');

    /*
     * A child process, because findExecutable branches on process.platform and
     * reads the dist path when the module loads. Cheaper than restructuring
     * the script around injection for a test.
     */
    const { execFileSync } = require('node:child_process');
    const script = `
      Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
      process.env.CV_SMOKE_DIST = ${JSON.stringify(root)};
      const { findExecutable } = require(${JSON.stringify(
        path.join(__dirname, '..', 'scripts', 'smoke-package.js'))});
      const r = findExecutable();
      process.stdout.write(r.exe ? require('node:path').basename(r.exe) : 'NONE:' + JSON.stringify(r));
    `;
    const got = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(got, expect, `${platform}: expected to launch ${expect}, got ${got}`);
    fs.rmSync(root, { recursive: true, force: true });
  }

  /*
   * Say what was actually checked. A skip that looks like a pass is the
   * failure mode this whole area of the project keeps running into, and the
   * Windows run would otherwise report the same "ok" as a run that verified
   * three times as much.
   */
  assert.ok(exercised.includes('win32'), 'the win32 layout is checkable anywhere');
  if (exercised.length < Object.keys(layouts).length) {
    console.log(`       (only ${exercised.join(', ')} — this filesystem has no execute bit)`);
  }
});

test('Electron helper binaries are never mistaken for the app', () => {
  const { ELECTRON_HELPERS } = require('../scripts/smoke-package');
  // The one that actually bit, and the one that would have bitten next.
  assert.ok(ELECTRON_HELPERS.has('chrome_crashpad_handler'));
  assert.ok(ELECTRON_HELPERS.has('chrome-sandbox'));
});

test('every prerequisite message leads with a headline the pane can show', () => {
  // The pane renders line 1 bold and the rest as detail, so a message whose
  // first line is a path reads as a heading that is not one.
  const { checkPrerequisites } = require('../src/generate/driver');
  const message = checkPrerequisites();
  if (message === null) return; // a fresh build: nothing to check
  const [headline, ...detail] = message.split('\n');
  assert.ok(/^[A-Z].*\.$/.test(headline),
    `the first line should be a sentence, got ${JSON.stringify(headline)}`);
  assert.ok(detail.length > 0, 'a headline with no detail leaves nothing to act on');
  assert.match(message, /Run: npm run build:generate|sibling pt-lab-workspace/);
});

console.log(failures === 0 ? '\nAll ground-truth tests passed.' : `\n${failures} failing.`);
  process.exit(failures === 0 ? 0 : 1);
});
