'use strict';

/**
 * The gap between two parts, measured against what is really there.
 *
 * Pure JavaScript — no addon, no Electron. Every record is built by hand, so
 * each expected gap is arithmetic: two horizontal edges ten pixels apart are
 * ten pixels apart, whatever the code happens to produce.
 *
 *   node test/gapsweep.js
 */

const assert = require('node:assert/strict');
const { gapRow, pxPerMm, truthPair, changedInputs, DEFAULTS } = require('../src/lab/gapsweep');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const PARTS = { moving: 'Cube', target: 'Table' };

/** A truth edge from (x0,y0) to (x1,y1), at depth z, belonging to `objects`. */
function gt(id, objects, x0, y0, x1, y1, { z = 0.45, visible = 1 } = {}) {
  return { type: 'gt-edge', id, cause: 'crease', objects, x0, y0, x1, y1, z0: z, z1: z, visible };
}

function seg(id, x0, y0, x1, y1, extra = {}) {
  return { type: 'edge-segment', id, x0, y0, x1, y1, length: Math.hypot(x1 - x0, y1 - y0), ...extra };
}

const hit = (detected, truth) => ({ kind: 'segment', role: 'hit', detected, truth });
const miss = (truth) => ({ kind: 'segment', role: 'miss', detected: null, truth });

/** The cube's bottom edge at y=100 above the table's front edge at y=110. */
const TRUTH = [
  gt(1, ['Cube'], 100, 100, 200, 100),
  gt(2, ['Table'], 50, 110, 250, 110),
];

test('detections on the truth measure the truth: ten pixels, no error', () => {
  const segments = [seg(10, 100, 100, 200, 100), seg(11, 50, 110, 250, 110)];
  const row = gapRow({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)] },
    { gapMm: 8 }, PARTS);
  assert.equal(row.pairFound, true);
  assert.ok(Math.abs(row.trueGapPx - 10) < 1e-9, `true gap ${row.trueGapPx}`);
  assert.ok(Math.abs(row.errorPx) < 1e-9, `error ${row.errorPx}`);
  assert.deepEqual(row.truthPair, [1, 2]);
});

test('an edge found half a pixel toward the target reads half a pixel short', () => {
  const segments = [seg(10, 100, 100.5, 200, 100.5), seg(11, 50, 110, 250, 110)];
  const row = gapRow({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)] },
    { gapMm: 8 }, PARTS);
  assert.ok(Math.abs(row.errorPx + 0.5) < 1e-9, `error ${row.errorPx}`);
});

test('the gap is measured where the truth overlaps, not at a detection\'s own middle', () => {
  // The detected cube edge is tilted: 0 px off at x=100, 2 px off at x=200.
  // The truth overlap is x 100..200, middle 150, where it is 1 px off.
  const segments = [seg(10, 100, 100, 200, 102), seg(11, 0, 110, 250, 110)];
  const row = gapRow({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)] },
    { gapMm: 8 }, PARTS);
  assert.ok(Math.abs(row.errorPx + 1) < 1e-6, `error ${row.errorPx}`);
});

test('the piece of an edge that covers the measuring point is used, not the longest piece', () => {
  // The table edge found in two pieces: a long one off to the right, and a
  // shorter one under the cube, where the gap is measured (x = 150).
  const segments = [seg(10, 100, 100, 200, 100), seg(11, 210, 111, 400, 111), seg(12, 60, 110, 190, 110)];
  const truth = [gt(1, ['Cube'], 100, 100, 200, 100), gt(2, ['Table'], 50, 110, 400, 110)];
  const row = gapRow({ truth, segments, explained: segments, matches: [hit(10, 1), hit(11, 2), hit(12, 2)] },
    { gapMm: 8 }, PARTS);
  assert.deepEqual(row.detectedPair, [10, 12]);
  assert.ok(Math.abs(row.errorPx) < 1e-9, `error ${row.errorPx}`);
});

test('a gap is not extrapolated from detections that stop short of where it is measured', () => {
  // A 20 px fragment of the cube edge at its far left end; the gap is measured at x = 150.
  const segments = [seg(10, 100, 100, 120, 100), seg(11, 50, 110, 250, 110)];
  const row = gapRow({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)] },
    { gapMm: 8 }, PARTS);
  assert.equal(row.pairFound, false);
  assert.equal(row.errorPx, null);
  assert.match(row.reason, /30\.0 px short/);
});

test('the error splits by edge, each against its own truth, and the parts add up', () => {
  // Cube edge found 0.25 px toward the cube (up, smaller y); table edge 0.5 px
  // toward the cube too. The gap reads 0.25 short.
  const segments = [seg(10, 100, 99.75, 200, 99.75), seg(11, 50, 109.5, 250, 109.5)];
  const row = gapRow({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)] },
    { gapMm: 8 }, PARTS);
  assert.ok(Math.abs(row.movingOffsetPx - 0.25) < 1e-9, `moving ${row.movingOffsetPx}`);
  assert.ok(Math.abs(row.targetOffsetPx - 0.5) < 1e-9, `target ${row.targetOffsetPx}`);
  assert.ok(Math.abs(row.errorPx - (row.movingOffsetPx - row.targetOffsetPx)) < 1e-9);
});

/** An edge-pair record placing segments `a` and `b` on the given lines. */
function pairRecord(id, a, b, extra = {}) {
  const edge = ([segment, x0, y0, x1, y1]) => ({ segment, x0, y0, x1, y1, shift: 0 });
  return { type: 'edge-pair', id, a: edge(a), b: edge(b), gapSigma: 0.02, strip: 'fit',
    levels: [0.3, 0.12, 0.6], ...extra };
}

test('a refit pair is read beside the detections, at the same point, and split the same way', () => {
  // Detected 1 px too far apart each, as blur leaves two close edges; the
  // pair record puts the cube's edge 0.1 px off its truth and the table's on.
  const segments = [seg(10, 100, 99, 200, 99), seg(11, 50, 111, 250, 111)];
  const pairs = [pairRecord(1, [10, 102, 100.1, 198, 100.1], [11, 102, 110, 198, 110])];
  const row = gapRow({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)], pairs },
    { gapMm: 8 }, PARTS);
  // The detections' own reading is what it always was.
  assert.ok(Math.abs(row.errorPx - 2) < 1e-9, `detected error ${row.errorPx}`);
  assert.ok(Math.abs(row.refit.gapPx - 9.9) < 1e-9, `refit gap ${row.refit.gapPx}`);
  assert.ok(Math.abs(row.refit.errorPx + 0.1) < 1e-9, `refit error ${row.refit.errorPx}`);
  assert.ok(Math.abs(row.refit.movingOffsetPx + 0.1) < 1e-9, `cube ${row.refit.movingOffsetPx}`);
  assert.ok(Math.abs(row.refit.targetOffsetPx) < 1e-9, `table ${row.refit.targetOffsetPx}`);
  assert.equal(row.refit.pair, 1);
  assert.equal(row.refit.from, 'pair');
  assert.equal(row.refit.gapSigma, 0.02);
  assert.equal(row.refit.stripLevel, 0.12);
});

test('which of the pair\'s edges is the moving part\'s is decided by segment id, not by a and b', () => {
  const segments = [seg(10, 100, 99, 200, 99), seg(11, 50, 111, 250, 111)];
  const swapped = [pairRecord(1, [11, 102, 110, 198, 110], [10, 102, 100.1, 198, 100.1])];
  const row = gapRow({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)], pairs: swapped },
    { gapMm: 8 }, PARTS);
  assert.ok(Math.abs(row.refit.errorPx + 0.1) < 1e-9, `refit error ${row.refit.errorPx}`);
});

test('a pair about other segments, or one that stops short of the measuring point, is not a reading', () => {
  const segments = [seg(10, 100, 99, 200, 99), seg(11, 50, 111, 250, 111)];
  const input = (pairs) => ({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)], pairs });
  const other = [pairRecord(1, [10, 102, 100, 198, 100], [12, 102, 104, 198, 104])];
  assert.equal(gapRow(input(other), { gapMm: 8 }, PARTS).refit, null);
  // The measuring point is x = 150; this pair's stretch ends at x = 140.
  const short = [pairRecord(1, [10, 102, 100, 140, 100], [11, 102, 110, 140, 110])];
  assert.equal(gapRow(input(short), { gapMm: 8 }, PARTS).refit, null);
  // And with no pairs at all the row says so the same way.
  assert.equal(gapRow(input(undefined), { gapMm: 8 }, PARTS).refit, null);
  assert.equal(gapRow(input(null), { gapMm: 8 }, PARTS).refit, null);
});

test('a pair found inside ONE detection is read where the detections give no gap at all', () => {
  // Only the table's edge is detected, as at 1 mm. findPairs found a second
  // edge 1.2 px above it, on the cube's side.
  const segments = [seg(11, 50, 110, 250, 110)];
  const pairs = [pairRecord(1, [11, 102, 108.8, 198, 108.8], [11, 102, 110, 198, 110])];
  const near = [gt(1, ['Cube'], 100, 108.5, 200, 108.5), TRUTH[1]];
  const row = gapRow({ truth: near, segments, explained: segments, matches: [miss(1), hit(11, 2)], pairs },
    { gapMm: 1 }, PARTS);
  assert.equal(row.pairFound, false);
  assert.match(row.reason, /no detection matched Cube/);
  assert.equal(row.measuredGapPx, null);
  assert.equal(row.refit.from, 'segment');
  assert.ok(Math.abs(row.refit.gapPx - 1.2) < 1e-9, `refit gap ${row.refit.gapPx}`);
  assert.ok(Math.abs(row.refit.errorPx + 0.3) < 1e-9, `refit error ${row.refit.errorPx}`);
  assert.ok(Math.abs(row.refit.movingOffsetPx + 0.3) < 1e-9, `cube ${row.refit.movingOffsetPx}`);
  assert.ok(Math.abs(row.refit.targetOffsetPx) < 1e-9, `table ${row.refit.targetOffsetPx}`);
});

test('which of a hidden pair\'s edges is the moving part\'s is decided by where they are', () => {
  // Both name segment 11, so ids say nothing; a and b the other way round.
  const segments = [seg(11, 50, 110, 250, 110)];
  const pairs = [pairRecord(1, [11, 102, 110, 198, 110], [11, 102, 108.8, 198, 108.8])];
  const near = [gt(1, ['Cube'], 100, 108.5, 200, 108.5), TRUTH[1]];
  const row = gapRow({ truth: near, segments, explained: segments, matches: [miss(1), hit(11, 2)], pairs },
    { gapMm: 1 }, PARTS);
  assert.ok(Math.abs(row.refit.gapPx - 1.2) < 1e-9, `refit gap ${row.refit.gapPx}`);
  assert.ok(Math.abs(row.refit.movingOffsetPx + 0.3) < 1e-9, `cube ${row.refit.movingOffsetPx}`);
});

test('a fragment matched to the other edge does not hide the pair inside the long detection', () => {
  // The cube's edge got a 7 px fragment of its own, well away from the
  // measuring point; the table's detection still holds both edges there.
  const segments = [seg(19, 101, 108.6, 108, 108.6), seg(11, 50, 110, 250, 110)];
  const pairs = [pairRecord(1, [11, 102, 108.8, 198, 108.8], [11, 102, 110, 198, 110])];
  const near = [gt(1, ['Cube'], 100, 108.5, 200, 108.5), TRUTH[1]];
  const row = gapRow({ truth: near, segments, explained: segments, matches: [hit(19, 1), hit(11, 2)], pairs },
    { gapMm: 1 }, PARTS);
  assert.equal(row.pairFound, false);
  assert.equal(row.refit.from, 'segment');
  assert.ok(Math.abs(row.refit.gapPx - 1.2) < 1e-9, `refit gap ${row.refit.gapPx}`);
});

test('a hidden pair in some other segment, or away from the measuring point, is not a reading', () => {
  const segments = [seg(11, 50, 110, 250, 110), seg(12, 50, 140, 250, 140)];
  const near = [gt(1, ['Cube'], 100, 108.5, 200, 108.5), TRUTH[1]];
  const input = (pairs) => ({ truth: near, segments, explained: segments, matches: [miss(1), hit(11, 2)], pairs });
  const elsewhere = [pairRecord(1, [12, 102, 138.8, 198, 138.8], [12, 102, 140, 198, 140])];
  assert.equal(gapRow(input(elsewhere), { gapMm: 1 }, PARTS).refit, null);
  const short = [pairRecord(1, [11, 60, 108.8, 120, 108.8], [11, 60, 110, 120, 110])];
  assert.equal(gapRow(input(short), { gapMm: 1 }, PARTS).refit, null);
});

test('no pair, no per-edge offsets', () => {
  const segments = [seg(10, 100, 100, 200, 100)];
  const row = gapRow({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1)] },
    { gapMm: 8 }, PARTS);
  assert.equal(row.movingOffsetPx, null);
  assert.equal(row.targetOffsetPx, null);
});

test('edges in the wrong order give a negative gap rather than a small positive one', () => {
  // The cube edge detected BELOW the table edge.
  const segments = [seg(10, 100, 113, 200, 113), seg(11, 50, 110, 250, 110)];
  const row = gapRow({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)] },
    { gapMm: 8 }, PARTS);
  assert.ok(Math.abs(row.measuredGapPx + 3) < 1e-9, `measured ${row.measuredGapPx}`);
});

test('a far edge that projects closer is not the facing one', () => {
  // The table's back edge is 4 px from the cube in the image and a metre deeper.
  const truth = [...TRUTH, gt(3, ['Table'], 50, 96, 250, 96, { z: 1.45 })];
  const pair = truthPair(truth, 'Cube', 'Table', 0.008, DEFAULTS);
  assert.equal(pair.b.id, 2);
});

test('parallel edges that do not overlap are not a pair', () => {
  const truth = [gt(1, ['Cube'], 0, 100, 40, 100), gt(2, ['Table'], 100, 110, 200, 110)];
  const row = gapRow({ truth, segments: [], explained: [], matches: [] }, { gapMm: 8 }, PARTS);
  assert.equal(row.trueGapPx, null);
  assert.equal(row.pairFound, false);
});

test('an unfound target edge still reports the true gap, and no error', () => {
  const segments = [seg(10, 100, 100, 200, 100)];
  const row = gapRow({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1), miss(2)] },
    { gapMm: 8 }, PARTS);
  assert.equal(row.pairFound, false);
  assert.ok(Math.abs(row.trueGapPx - 10) < 1e-9);
  assert.equal(row.errorPx, null, 'a missing edge is not an error of zero');
  assert.deepEqual(row.target, { findable: 1, found: 0 });
  assert.deepEqual(row.moving, { findable: 1, found: 1 });
});

test('one segment running from the cube\'s edge onto the table\'s is counted as spanning both', () => {
  const truth = [gt(1, ['Cube'], 0, 100, 100, 100), gt(2, ['Table'], 0, 103, 200, 103)];
  const merged = seg(10, 0, 100, 200, 103);
  const row = gapRow({ truth, segments: [merged], explained: [merged], matches: [hit(10, 2)] },
    { gapMm: 2 }, PARTS);
  assert.equal(row.spansBoth, 1);
  const separate = [seg(11, 0, 100, 100, 100), seg(12, 0, 103, 200, 103)];
  const ok = gapRow({ truth, segments: separate, explained: separate, matches: [hit(11, 1), hit(12, 2)] },
    { gapMm: 2 }, PARTS);
  assert.equal(ok.spansBoth, 0);
});

test('only detections in the gap are counted by cause', () => {
  const segments = [
    seg(10, 100, 100, 200, 100, { cause: 'occlusion' }),
    seg(11, 50, 110, 250, 110, { cause: 'crease' }),
    seg(12, 120, 105, 180, 105, { cause: 'shading' }),     // in the gap
    seg(13, 120, 160, 180, 160, { cause: 'shading' }),     // far below it
  ];
  const row = gapRow({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)] },
    { gapMm: 8 }, PARTS);
  assert.deepEqual(row.causes, { occlusion: 1, crease: 1, shading: 1 });
});

test('pixels per millimetre is the median over steps with a gap', () => {
  const rows = [
    { gapMm: 0, trueGapPx: 0 }, { gapMm: 1, trueGapPx: 1.1 },
    { gapMm: 10, trueGapPx: 12 }, { gapMm: 20, trueGapPx: 25 }, { gapMm: 5, trueGapPx: null },
  ];
  assert.equal(pxPerMm(rows), 1.2);
  assert.equal(pxPerMm([]), null);
});

/* ---- whether two analyses measured the same renders ---------------- */

const FILES = { image: 'a1', truth: 'b1', depth: 'c1', normal: 'd1', albedo: 'e1' };

test('identical inputs report no change', () => {
  assert.deepEqual(changedInputs({ 'gap-5mm.png': FILES }, { 'gap-5mm.png': { ...FILES } }), []);
});

test('a re-rendered shot is reported, naming which of its files differ', () => {
  const now = { 'gap-5mm.png': { ...FILES, image: 'a2', depth: 'c2' }, 'gap-2mm.png': FILES };
  const was = { 'gap-5mm.png': FILES, 'gap-2mm.png': FILES };
  assert.deepEqual(changedInputs(was, now), [{ shot: 'gap-5mm.png', files: ['image', 'depth'] }]);
});

test('a shot on one side only counts as changed, either way round', () => {
  assert.deepEqual(changedInputs({}, { 'gap-5mm.png': FILES }), [{ shot: 'gap-5mm.png', files: ['new'] }]);
  assert.deepEqual(changedInputs({ 'gap-5mm.png': FILES }, {}), [{ shot: 'gap-5mm.png', files: ['gone'] }]);
});

console.log(failures === 0 ? '\nAll gap-sweep tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
