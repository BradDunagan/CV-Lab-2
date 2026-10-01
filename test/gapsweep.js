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
const { gapRow, pxPerMm, truthPair, DEFAULTS } = require('../src/lab/gapsweep');

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

console.log(failures === 0 ? '\nAll gap-sweep tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
