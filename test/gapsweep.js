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
const {
  gapRow, gapRows, numberPairs, pxPerMm, pxPerMmSlope, truthPair, truthPairs, changedInputs, orbitViews, DEFAULTS,
} = require('../packages/vision/src/gapsweep.js');

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

test('a pair\'s ledge reaches the row, and a pair without one says null', () => {
  const segments = [seg(10, 100, 99, 200, 99), seg(11, 50, 111, 250, 111)];
  const input = (pairs) => ({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)], pairs });
  const ledge = { gain: 1.8, edge: 'b' };
  const withLedge = [pairRecord(1, [10, 102, 100, 198, 100], [11, 102, 110, 198, 110], { ledge })];
  assert.deepEqual(gapRow(input(withLedge), { gapMm: 8 }, PARTS).refit.ledge, ledge);
  const without = [pairRecord(1, [10, 102, 100, 198, 100], [11, 102, 110, 198, 110])];
  assert.equal(gapRow(input(without), { gapMm: 8 }, PARTS).refit.ledge, null);
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

/** An edge-track record: trackPair's, the still line carried, the moving one fitted. */
const trackRecord = (still, moving, toward, extra = {}) => ({
  type: 'edge-track', id: 1,
  still: { x0: still[0], y0: still[1], x1: still[2], y1: still[3] },
  moving: { x0: moving[0], y0: moving[1], x1: moving[2], y1: moving[3] },
  toward, gapSigma: 0.01, rms: 0.002, stripLevel: 0.12, ...extra,
});

test('a tracked pair is read at the same point as the rest, and needs no detection', () => {
  // The table's line carried 0.2 px low, the cube's edge fitted 0.1 px low.
  const tracks = [trackRecord([60, 110.2, 240, 110.2], [60, 100.1, 240, 100.1], [150, 90])];
  const row = gapRow({ truth: TRUTH, segments: [], explained: [], matches: [miss(1), miss(2)], tracks },
    { gapMm: 8 }, PARTS);
  assert.equal(row.pairFound, false, 'nothing was detected');
  assert.ok(Math.abs(row.tracked.gapPx - 10.1) < 1e-9, `tracked gap ${row.tracked.gapPx}`);
  assert.ok(Math.abs(row.tracked.errorPx - 0.1) < 1e-9, `tracked error ${row.tracked.errorPx}`);
  assert.ok(Math.abs(row.tracked.targetOffsetPx + 0.2) < 1e-9, `table ${row.tracked.targetOffsetPx}`);
  assert.equal(row.tracked.endsPx.length, 2);
  assert.equal(row.tracked.gapSigma, 0.01);
});

test('a track is matched to a pair by where its still line lies, not by order', () => {
  const input = (tracks) => ({ truth: TRUTH, segments: [], explained: [], matches: [miss(1), miss(2)], tracks });
  // Its still line on the cube's edge, or 5 px off the table's, or stopping
  // short of the measuring point: none of them speaks for this pair.
  for (const still of [[60, 100, 240, 100], [60, 115, 240, 115], [60, 110, 130, 110]]) {
    const t = [trackRecord(still, [60, 99, 240, 99], [150, 90])];
    assert.equal(gapRow(input(t), { gapMm: 8 }, PARTS).tracked, null, `still line ${still}`);
  }
  // Among two, the one on the table's edge.
  const two = [trackRecord([60, 102, 240, 102], [60, 99, 240, 99], [150, 90]),
    trackRecord([60, 110, 240, 110], [60, 100, 240, 100], [150, 90], { gapSigma: 0.03 })];
  assert.equal(gapRow(input(two), { gapMm: 8 }, PARTS).tracked.gapSigma, 0.03);
});

test('a free ledge fit reaches the row beside the track, and a held ledge rides on the tracked reading', () => {
  const ledge = { offset: 3.1, width: 0.2, level: 0.17, seen: true, gain: 2.4 };
  const fits = [trackRecord([60, 110, 240, 110], [60, 100, 240, 100], [150, 90], { ledge })];
  const tracks = [trackRecord([60, 110, 240, 110], [60, 100, 240, 100], [150, 90], { ledge: { ...ledge, gain: 2.2 } })];
  const row = gapRow({ truth: TRUTH, segments: [], explained: [], matches: [miss(1), miss(2)], tracks, ledgeFits: fits },
    { gapMm: 8 }, PARTS);
  assert.deepEqual(row.ledgeFit, ledge);
  assert.equal(row.tracked.ledge.gain, 2.2);
  // Without fits asked for, the row says nothing about them.
  const none = gapRow({ truth: TRUTH, segments: [], explained: [], matches: [miss(1), miss(2)], tracks }, { gapMm: 8 }, PARTS);
  assert.equal('ledgeFit' in none, false);
});

test('a ledge table: where it ends is the flush sweep\'s gap in the lift, its shadow the sharp fits\' width per mm', () => {
  const { flushLines, ledgeTable } = require('../packages/vision/src/ledge.js');
  // A y sweep from 4 mm: the gap 1.04 px per mm of lift, less 0.15, read with noise.
  const noise = [0.01, -0.02, 0.015, -0.005, 0];
  const run = { axis: [0, 1, 0], offsetMm: [0, 4, 0], rows: [-2, -1, 0, 1, 2].map((g, k) => (
    { yaw: 35, elevation: 20, pair: 2, pairAngle: 15, gapMm: g, tracked: { gapPx: 1.04 * (4 + g) - 0.15 + noise[k] } })) };
  const [line] = flushLines(run);
  assert.ok(Math.abs(line.flush[0] - 1.04) < 0.02 && Math.abs(line.flush[1] + 0.15) < 0.1, `flush ${line.flush}`);
  // Only fits with lit ledge to see the shadow against, and clearly better
  // than the strip, count; widths per mm of lift.
  const fit = (gapMm, width, gain, lit = 3) => ({ yaw: 35, elevation: 20, pair: 2, pairAngle: 16, gapMm, ledgeFit: { width, gain, lit, seen: lit > 0 } });
  const x = { axis: [1, 0, 0], offsetMm: [0, 4, 0], rows: [fit(-4, 0.4, 2.1), fit(-2, 0.8, 1.7), fit(-1, 9, 1.1), fit(1, 9, 3, -1),
    fit(-1.5, 9, 1.6, 0.4), fit(-3, 0.6, 1.9)] };
  const [entry] = ledgeTable(run, [x]);
  assert.equal(entry.widthsOf, 3);
  assert.ok(Math.abs(entry.widthPerMm - 0.15) < 1e-12, `width per mm ${entry.widthPerMm}`);
  // A pair the fits never saw has no shadow width, not none at all.
  assert.equal(ledgeTable(run, []).at(0).widthPerMm, 0);
  // Slid, or a list of poses, is not a flush sweep.
  assert.throws(() => flushLines({ ...run, offsetMm: [1, 4, 0] }), /nothing slid/);
});

test('a ledge table with the moving part below: the lift is its drop, and the ledge its own', () => {
  const { flushLines, ledgeTable, movingBelow } = require('../packages/vision/src/ledge.js');
  // The same sweep mirrored: the moving part 4 mm below, swept further down.
  const run = { axis: [0, -1, 0], offsetMm: [0, -4, 0], rows: [-2, -1, 0, 1, 2].map((g) => (
    { yaw: 35, elevation: 20, pair: 2, pairAngle: 15, gapMm: g, tracked: { gapPx: 1.04 * (4 + g) - 0.15 } })) };
  const [line] = flushLines(run);
  assert.ok(Math.abs(line.flush[0] - 1.04) < 1e-9 && Math.abs(line.flush[1] + 0.15) < 1e-9, `flush ${line.flush}`);
  assert.equal(line.on, 'moving');
  const fit = (gapMm, width) => ({ yaw: 35, elevation: 20, pair: 2, pairAngle: 16, gapMm, ledgeFit: { width, gain: 2, lit: 3, seen: true } });
  const below = { axis: [-1, 0, 0], offsetMm: [0, -4, 0], rows: [fit(-4, 0.4), fit(-2, 0.4)] };
  assert.ok(Math.abs(ledgeTable(run, [below])[0].widthPerMm - 0.1) < 1e-12);
  // Fits made with the moving part above are another ledge.
  const above = { ...below, offsetMm: [0, 4, 0] };
  assert.throws(() => ledgeTable(run, [above]), /other side/);
  // Posed: below when every pose is at or under contact.
  assert.equal(movingBelow({ poses: [{ mm: [1, -2, 0] }, { mm: [0, -0.5, 1] }] }), true);
  assert.equal(movingBelow({ poses: [{ mm: [1, 2, 0] }] }), false);
});

test('identified from a believed pose, scored against the real truth: the readings stay, the true gap moves', () => {
  /*
   * The belief has the cube 1 px too high (its edge at y=99) and the table
   * where it is. The tracked reading is the same 10.1 px whichever truth
   * identified it; against the real truth -- a 10 px gap -- it is 0.1 px
   * long, not 1.1 px.
   */
  const believed = [gt(1, ['Cube'], 100, 99, 200, 99), gt(2, ['Table'], 50, 110, 250, 110)];
  const tracks = [trackRecord([60, 110.2, 240, 110.2], [60, 100.1, 240, 100.1], [150, 90])];
  const input = { truth: believed, segments: [], explained: [], matches: [miss(1), miss(2)], tracks };
  const [plain] = gapRows(input, { gapMm: 8 }, PARTS);
  assert.ok(Math.abs(plain.tracked.errorPx + 0.9) < 1e-9, `against the belief ${plain.tracked.errorPx}`);
  const [row] = gapRows(input, { gapMm: 8 }, PARTS, { scoreTruth: TRUTH });
  assert.equal(row.identifiedFrom, 'believed');
  assert.ok(Math.abs(row.tracked.gapPx - 10.1) < 1e-9, 'the reading is not touched');
  assert.ok(Math.abs(row.trueGapPx - 10) < 1e-9, `true ${row.trueGapPx}`);
  assert.ok(Math.abs(row.believedGapPx - 11) < 1e-9, `believed ${row.believedGapPx}`);
  assert.ok(Math.abs(row.tracked.errorPx - 0.1) < 1e-9, `error ${row.tracked.errorPx}`);
  assert.deepEqual(row.truthPair, [1, 2]);
  // The ends too: read where the belief puts them, true by the real lines.
  assert.ok(row.endsTruePx.every((e) => Math.abs(e - 10) < 1e-9), `ends ${row.endsTruePx}`);
  // ...and by the real lines' own slope where they are not parallel.
  const tilted = [gt(1, ['Cube'], 100, 99, 200, 101), gt(2, ['Table'], 50, 110, 250, 110)];
  const [slant] = gapRows(input, { gapMm: 8 }, PARTS, { scoreTruth: tilted });
  assert.ok(slant.endsTruePx[0] > slant.endsTruePx[1], `ends ${slant.endsTruePx}`);
  // A real truth with nothing near the believed pair: the true gap is unknown away from contact, zero at it.
  const far = [gt(1, ['Cube'], 100, 40, 200, 40), gt(2, ['Table'], 50, 50, 250, 50)];
  const [lost] = gapRows(input, { gapMm: 8 }, PARTS, { scoreTruth: far });
  assert.equal(lost.trueGapPx, null);
  assert.equal(lost.tracked.errorPx, null);
  assert.equal(lost.endsTruePx, null);
  const [touching] = gapRows(input, { gapMm: 0 }, PARTS, { scoreTruth: far });
  assert.equal(touching.trueGapPx, 0);
  assert.ok(Math.abs(touching.tracked.errorPx - 10.1) < 1e-9);
  assert.deepEqual(touching.endsTruePx, [0, 0]);
});

test('where the truth has no facing pair a track is still a row, and at contact its gap is its error', () => {
  // Only the table's edge in the truth: nothing faces it.
  const truth = [gt(2, ['Table'], 50, 110, 250, 110)];
  const tracks = [trackRecord([60, 110, 240, 110], [60, 109.92, 240, 109.92], [150, 90], { gap: 0.08 })];
  const input = { truth, segments: [], explained: [], matches: [miss(2)], tracks };
  const [row] = gapRows(input, { gapMm: 0 }, PARTS);
  assert.equal(row.reason, 'no facing pair in the ground truth');
  assert.equal(row.trueGapPx, 0);
  assert.equal(row.tracked.gapPx, 0.08);
  assert.equal(row.tracked.errorPx, 0.08, 'at contact the true gap is zero');
  assert.ok(Math.abs(row.pairAngle) < 1e-9, `angle ${row.pairAngle}`);
  // Away from contact nothing says what the gap should be.
  const [away] = gapRows(input, { gapMm: 1 }, PARTS);
  assert.equal(away.trueGapPx, null);
  assert.equal(away.tracked.errorPx, null);
  // And with no tracks, the one row it always was.
  const [none] = gapRows({ ...input, tracks: null }, { gapMm: 0 }, PARTS);
  assert.equal(none.pair, null);
  assert.equal(none.tracked, null);
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

test('two detections that both reach the measuring point are the pair, whatever is inside one of them', () => {
  // Both edges detected, 6.5 px apart: too far for fitPairs, so no record of
  // the two. findPairs found a 2 px strip inside the lower one -- a shadow's
  // edge beside it. That is not this gap.
  const segments = [seg(10, 100, 103.5, 200, 103.5), seg(11, 50, 110, 250, 110)];
  const pairs = [pairRecord(1, [11, 102, 108, 198, 108], [11, 102, 110, 198, 110])];
  const wide = [gt(1, ['Cube'], 100, 104, 200, 104), TRUTH[1]];
  const row = gapRow({ truth: wide, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)], pairs },
    { gapMm: 5 }, PARTS);
  assert.equal(row.pairFound, true);
  assert.ok(Math.abs(row.errorPx - 0.5) < 1e-9, `detected error ${row.errorPx}`);
  assert.equal(row.refit, null);
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

test('the gap is also read a sixth in from each end, which is what shows a turn', () => {
  // The cube's edge turned: 1 px further from the table at x=100 than the
  // table's 10, 1 px nearer at x=200. The truth pair overlaps over x=100..200,
  // so the end points are at x=116.7 and 183.3, and the middle reads 10.
  const turned = [gt(1, ['Cube'], 100, 99, 200, 101), TRUTH[1]];
  const segments = [seg(10, 100, 99, 200, 101), seg(11, 50, 110, 250, 110)];
  const pairs = [pairRecord(1, [10, 100, 99.2, 200, 100.8], [11, 100, 110, 200, 110])];
  const row = gapRow({ truth: turned, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)], pairs },
    { gapMm: 8 }, PARTS);
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a}, expected ${b}`);
  near(row.trueGapPx, 10, 'middle');
  near(row.endsTruePx[0], 10 + 2 / 3, 'end at x=116.7');
  near(row.endsTruePx[1], 10 - 2 / 3, 'end at x=183.3');
  // The detections are on the truth; the refit's line is turned less.
  near(row.endsDetectedPx[0], row.endsTruePx[0], 'detected end 1');
  near(row.endsDetectedPx[1], row.endsTruePx[1], 'detected end 2');
  near(row.refit.endsPx[0], 10 + 0.8 * 2 / 3, 'refit end 1');
  near(row.refit.endsPx[1], 10 - 0.8 * 2 / 3, 'refit end 2');
});

test('an end the lines do not reach is not read', () => {
  // The cube's detection covers only x=140..200, so the end at x=116.7 is 23 px
  // past it; the other end and the middle are read.
  const segments = [seg(10, 140, 100, 200, 100), seg(11, 50, 110, 250, 110)];
  const row = gapRow({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)] },
    { gapMm: 8 }, PARTS);
  assert.equal(row.endsDetectedPx[0], null);
  assert.ok(Math.abs(row.endsDetectedPx[1] - 10) < 1e-9);
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

test('a long target edge receding in depth still faces the part resting on its near end', () => {
  // A table edge seen obliquely: 0.4 m deep at x=50, 1.6 m at x=250. Its mean
  // depth is 1.0 m; where the cube sits (x=100..200) it is about 0.5 m, and
  // that is where the cube is. Compared by mean depth, this is no pair.
  const table = { ...gt(2, ['Table'], 50, 110, 250, 110), z0: 0.4, z1: 1.6 };
  const at = (x) => 1 / ((1 - (x - 50) / 200) / 0.4 + ((x - 50) / 200) / 1.6);
  const cube = { ...gt(1, ['Cube'], 100, 100, 200, 100), z0: at(100), z1: at(200) };
  const pair = truthPair([cube, table], 'Cube', 'Table', 0.008, DEFAULTS);
  assert.ok(pair, 'no facing pair');
  assert.deepEqual([pair.a.id, pair.b.id], [1, 2]);
  // And an edge at the table's MEAN depth, which is not where the table is
  // under it, is not facing it.
  const elsewhere = { ...gt(1, ['Cube'], 100, 100, 200, 100), z0: 1.0, z1: 1.0 };
  assert.equal(truthPair([elsewhere, table], 'Cube', 'Table', 0.008, DEFAULTS), null);
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

/* ---- more than one facing pair --------------------------------------- */

/*
 * A cube stacked on a cube, seen from a corner: each shows two faces, so there
 * are two facing pairs, one down each side of the near vertical edge. Drawn
 * here as a V -- the left pair falling to the corner at (150, 100), the right
 * pair rising away from it -- with the top cube's edges 6 px above the base's.
 */
const STACK = [
  gt(1, ['Top'], 50, 74, 150, 94),      // top cube, bottom-left edge
  gt(2, ['Top'], 150, 94, 230, 70),     // top cube, bottom-right edge
  gt(3, ['Base'], 50, 80, 150, 100),    // base cube, top-left edge
  gt(4, ['Base'], 150, 100, 230, 76),   // base cube, top-right edge
  gt(5, ['Top'], 50, 14, 150, 34),      // top cube's own top-left edge, 60 px up
  gt(6, ['Base'], 50, 140, 150, 160),   // base cube's bottom-left edge, 60 px down
];
const STACK_PARTS = { moving: 'Top', target: 'Base' };

test('a stack seen from a corner has two facing pairs, left to right', () => {
  const pairs = truthPairs(STACK, 'Top', 'Base', 0.005, DEFAULTS);
  assert.deepEqual(pairs.map((p) => [p.a.id, p.b.id]), [[1, 3], [2, 4]]);
  assert.ok(pairs[0].facing.at[0] < pairs[1].facing.at[0]);
});

test('an edge pairs only with its nearest facing edge, both ways round', () => {
  // 5 is parallel to 3 and overlaps it, and so is 1 to 6: neither is a pair,
  // because 3's nearest is 1 and 1's nearest is 3.
  const ids = truthPairs(STACK, 'Top', 'Base', 0.005, DEFAULTS).flatMap((p) => [p.a.id, p.b.id]);
  assert.ok(!ids.includes(5) && !ids.includes(6), `paired ${ids}`);
  // Take the near pair away and the far edges are each other's nearest.
  const far = truthPairs(STACK.filter((e) => e.id === 5 || e.id === 3), 'Top', 'Base', 0.005, DEFAULTS);
  assert.deepEqual(far.map((p) => [p.a.id, p.b.id]), [[5, 3]]);
});

test('two edges with nothing nearer are not a pair of this gap if they are far further apart', () => {
  // The top cube's far top edge and the base's far bottom edge, off to the
  // right where nothing else is: each is the other's nearest, 200 px apart.
  const far = [...STACK,
    gt(7, ['Top'], 300, 10, 400, 10), gt(8, ['Base'], 300, 210, 400, 210)];
  const pairs = truthPairs(far, 'Top', 'Base', 0.005, DEFAULTS);
  assert.deepEqual(pairs.map((p) => [p.a.id, p.b.id]), [[1, 3], [2, 4]]);
  // A pair a few pixels further apart than a nearly closed one is still one:
  // a slide closes one pair's gap and leaves the other's where it was.
  const slid = STACK.map((e) => (e.id === 1 ? gt(1, ['Top'], 50, 79.5, 150, 99.5) : e));
  assert.equal(truthPairs(slid, 'Top', 'Base', 0.005, DEFAULTS).length, 2);
});

test('a moving part BELOW, seen from above: its gap is positive though its middle projects above the gap', () => {
  // The top cube still, its bottom-front edge at y=50; the base lowered 4 px,
  // its near top edge at y=54. From high up the base's far top edge is at
  // y=10 and its foreshortened front face short, so the mean of its edges'
  // midpoints (y 40) is ABOVE its own near top edge: signed toward that
  // middle, the gap read -4, an overhang (design-lab-model.md §5, "A
  // thirty-fifth"). The still part's middle is higher still (y 0).
  const high = [
    gt(1, ['Top'], 50, 50, 150, 50), gt(2, ['Top'], 50, 0, 150, 0),
    gt(3, ['Top'], 50, -30, 150, -30, { visible: 0 }), gt(4, ['Top'], 50, -20, 150, -20, { visible: 0 }),
    gt(5, ['Base'], 50, 54, 150, 54), gt(6, ['Base'], 50, 70, 150, 70),
    // The base's back edges, behind the top cube: unseen, but part of its middle.
    gt(7, ['Base'], 50, 10, 150, 10, { visible: 0 }), gt(8, ['Base'], 50, 26, 150, 26, { visible: 0 }),
  ];
  const [p] = truthPairs(high, 'Base', 'Top', 0.005, DEFAULTS);
  assert.deepEqual([p.a.id, p.b.id], [5, 1]);
  assert.ok(Math.abs(p.facing.gap - 4) < 1e-9, `apart, not overhanging: ${p.facing.gap}`);
  // The same pair with the base slid past the top cube's edge is negative.
  const over = high.map((e) => (e.id === 5 ? gt(5, ['Base'], 50, 47, 150, 47) : e));
  const o = truthPairs(over, 'Base', 'Top', 0.005, DEFAULTS)[0].facing.gap;
  assert.ok(Math.abs(o + 3) < 1e-9, `overhang: ${o}`);
});

test('the closest pair of all is one of the pairs, so the one-pair reading has not moved', () => {
  const closest = truthPair(STACK, 'Top', 'Base', 0.005, DEFAULTS);
  const pairs = truthPairs(STACK, 'Top', 'Base', 0.005, DEFAULTS);
  assert.ok(pairs.some((p) => p.a.id === closest.a.id && p.b.id === closest.b.id));
});

test('each pair gets its own row, numbered, with its own reading', () => {
  // The left pair detected where it is; the right pair's lower edge detected
  // 1 px too high, as a shadow boundary beside it would be.
  const segments = [
    seg(10, 50, 74, 150, 94), seg(11, 50, 80, 150, 100),
    seg(12, 150, 94, 230, 70), seg(13, 150, 99, 230, 75),
  ];
  const matches = [hit(10, 1), hit(11, 3), hit(12, 2), hit(13, 4)];
  const rows = gapRows({ truth: STACK, segments, explained: segments, matches }, { gapMm: 5 }, STACK_PARTS);
  assert.deepEqual(rows.map((r) => r.pair), [1, 2]);
  assert.deepEqual(rows.map((r) => r.truthPair), [[1, 3], [2, 4]]);
  assert.ok(Math.abs(rows[0].errorPx) < 1e-9, `left pair error ${rows[0].errorPx}`);
  assert.ok(rows[1].errorPx < -0.9 && rows[1].errorPx > -1, `right pair error ${rows[1].errorPx}`);
  assert.ok(Math.abs(rows[1].movingOffsetPx) < 1e-9, 'the top cube\'s edge was on its truth');
  // What is counted over the whole image is the same in both rows.
  assert.deepEqual(rows[0].moving, rows[1].moving);
});

test('a shot with no facing pair still gets one row, saying so', () => {
  const rows = gapRows({ truth: [STACK[0]], segments: [], explained: [], matches: [] }, { gapMm: 5 }, STACK_PARTS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pair, null);
  assert.match(rows[0].reason, /no facing pair/);
});

test('an edge that has crossed the target\'s is a negative gap, not a small positive one', () => {
  // The top cube slid until its bottom-left edge is 3 px BELOW the base's
  // top-left edge. Its other edges are where they were, so the part is still
  // above. Signed toward the edge itself this read +3.
  const slid = STACK.map((e) => (e.id === 1 ? gt(1, ['Top'], 50, 83, 150, 103) : e));
  const pair = truthPairs(slid, 'Top', 'Base', 0.005, DEFAULTS).find((p) => p.a.id === 1);
  assert.ok(pair, 'no pair');
  assert.ok(pair.facing.gap < -2.9 && pair.facing.gap > -3, `gap ${pair.facing.gap}`);
  // And the reading of it is negative too, against the same normal.
  const segments = [seg(10, 50, 83, 150, 103), seg(11, 50, 80, 150, 100)];
  const [row] = gapRows({ truth: slid, segments, explained: segments, matches: [hit(10, 1), hit(11, 3)] },
    { gapMm: 0, separationMm: 5 }, STACK_PARTS);
  assert.ok(Math.abs(row.errorPx) < 1e-9, `error ${row.errorPx}`);
  assert.ok(row.measuredGapPx < 0);
});

test('a row says which way its pair runs in the image, whichever way the edge was written', () => {
  const segments = [];
  const rows = gapRows({ truth: STACK, segments, explained: segments, matches: [] }, { gapMm: 5 }, STACK_PARTS);
  // The left pair falls 20 in 100: 11.3 degrees. The right rises 24 in 80: 163.3.
  assert.ok(Math.abs(rows[0].pairAngle - 11.31) < 0.01, `left ${rows[0].pairAngle}`);
  assert.ok(Math.abs(rows[1].pairAngle - 163.30) < 0.01, `right ${rows[1].pairAngle}`);
  const flipped = STACK.map((e) => (e.id === 3 ? { ...e, x0: e.x1, y0: e.y1, x1: e.x0, y1: e.y0 } : e));
  const again = gapRows({ truth: flipped, segments, explained: segments, matches: [] }, { gapMm: 5 }, STACK_PARTS);
  assert.ok(Math.abs(again[0].pairAngle - rows[0].pairAngle) < 1e-9);
});

test('pairs keep their numbers through a shot that has lost one of them', () => {
  // Three shots of one view. The middle one has only the pair that runs at
  // 163 degrees; shot by shot it would be called pair 1, and it is pair 2.
  const rows = [
    { gapMm: 5, pair: 1, pairAngle: 11.3 }, { gapMm: 5, pair: 2, pairAngle: 163.3 },
    { gapMm: 50, pair: 1, pairAngle: 163.9 },
    { gapMm: 2, pair: 1, pairAngle: 11.2 }, { gapMm: 2, pair: 2, pairAngle: 163.2 },
    { gapMm: 0, pair: null, pairAngle: null },
  ];
  assert.deepEqual(numberPairs(rows).map((r) => r.pair), [1, 2, 2, 1, 2, null]);
  // In the order given, and the rows it was given untouched.
  assert.deepEqual(numberPairs(rows).map((r) => r.gapMm), [5, 5, 50, 2, 2, 0]);
  assert.equal(rows[2].pair, 1);
});

test('a pair running along the image\'s horizontal is one pair, not one at 1 degree and one at 179', () => {
  const rows = [{ pairAngle: 179.2 }, { pairAngle: 0.6 }, { pairAngle: 90 }, { pairAngle: 178.8 }];
  const n = numberPairs(rows).map((r) => r.pair);
  assert.equal(n[0], n[1]);
  assert.equal(n[0], n[3]);
  assert.notEqual(n[0], n[2]);
});

test('along a sweep across an open gap, pixels per millimetre is the slope, signed', () => {
  // 2 mm up, slid sideways: the gap this pair sees closes 0.4 px per mm.
  const rows = [-2, -1, 0, 1, 2].map((gapMm) => ({ gapMm, trueGapPx: 2.4 - 0.4 * gapMm }));
  assert.ok(Math.abs(pxPerMmSlope(rows) + 0.4) < 1e-12);
  // A pair that cannot see the direction: no slope to speak of.
  assert.ok(Math.abs(pxPerMmSlope([-2, 0, 2].map((gapMm) => ({ gapMm, trueGapPx: 2.4 })))) < 1e-12);
  // Steps with no truth pair are left out; one step alone is not a slope.
  assert.ok(Math.abs(pxPerMmSlope([{ gapMm: -1, trueGapPx: 3 }, { gapMm: 0, trueGapPx: null }, { gapMm: 1, trueGapPx: 2 }]) + 0.5) < 1e-12);
  assert.equal(pxPerMmSlope([{ gapMm: 1, trueGapPx: 2 }]), null);
});

test('a sweep across an open gap says how far apart the parts are, for the depth test', () => {
  // Step 0 of a sideways sweep at a 5 mm lift: the parts are 5 mm apart, and
  // a shot that said 0 would look for edges at the same depth to within the
  // slack alone. The receding table of the test above, 3 cm deeper than the
  // cube at the measuring point.
  const table = { ...gt(2, ['Table'], 50, 110, 250, 110), z0: 0.53, z1: 0.53 };
  const cube = { ...gt(1, ['Cube'], 100, 100, 200, 100), z0: 0.5, z1: 0.5 };
  const input = { truth: [cube, table], segments: [], explained: [], matches: [] };
  assert.match(gapRow(input, { gapMm: 0 }, PARTS).reason, /no facing pair/);
  assert.equal(gapRow(input, { gapMm: 0, separationMm: 15 }, PARTS).truthPair?.[0], 1);
});

/* ---- a grid of views ------------------------------------------------- */

// 1 m from its target, 30 degrees round and 45 up: sin 45 = cos 45 = 0.7071.
const CAMERA = {
  target: [1, 2, 3],
  position: [1 + Math.SQRT1_2 * 0.5, 2 + Math.SQRT1_2, 3 + Math.SQRT1_2 * Math.sqrt(0.75)],
};
const close3 = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-9);

test('no angles, no grid: the saved camera is used as it stands', () => {
  assert.equal(orbitViews(CAMERA, {}), null);
  assert.equal(orbitViews(CAMERA, { yaw: null, elevation: null }), null);
});

test('at its own yaw and elevation the orbit puts the camera back where it was', () => {
  const [v] = orbitViews(CAMERA, { yaw: [30], elevation: [45] });
  assert.ok(close3(v.camera, CAMERA.position), `camera at ${v.camera}`);
});

test('every view is at the saved distance from the saved target', () => {
  const views = orbitViews(CAMERA, { yaw: [0, 20, 70, -40], elevation: [0, 15, 75] });
  assert.equal(views.length, 12);
  for (const v of views) {
    const r = Math.hypot(...v.camera.map((c, k) => c - CAMERA.target[k]));
    assert.ok(Math.abs(r - 1) < 1e-9, `yaw ${v.yaw} elevation ${v.elevation}: ${r} m from the target`);
  }
});

test('yaw 0 looks along -z, 90 along -x; elevation raises the camera', () => {
  const at = (yaw, elevation) => orbitViews(CAMERA, { yaw: [yaw], elevation: [elevation] })[0].camera;
  assert.ok(close3(at(0, 0), [1, 2, 4]), `${at(0, 0)}`);
  assert.ok(close3(at(90, 0), [2, 2, 3]), `${at(90, 0)}`);
  assert.ok(close3(at(0, 30), [1, 2.5, 3 + Math.sqrt(0.75)]), `${at(0, 30)}`);
});

test('one list alone sweeps that axis through the saved view', () => {
  const views = orbitViews(CAMERA, { elevation: [0, 45, 60] });
  assert.deepEqual(views.map((v) => [v.yaw, v.elevation]), [[30, 0], [30, 45], [30, 60]]);
  assert.ok(close3(views[1].camera, CAMERA.position));
  const yaws = orbitViews(CAMERA, { yaw: [0, 30] });
  assert.deepEqual(yaws.map((v) => [v.yaw, v.elevation]), [[0, 45], [30, 45]]);
});

test('views come elevation by elevation, each across the yaws', () => {
  const views = orbitViews(CAMERA, { yaw: [0, 20], elevation: [5, 15] });
  assert.deepEqual(views.map((v) => [v.elevation, v.yaw]), [[5, 0], [5, 20], [15, 0], [15, 20]]);
});

test('the truth pair\'s shared length is carried in the row', () => {
  const segments = [seg(10, 100, 100, 200, 100), seg(11, 50, 110, 250, 110)];
  const row = gapRow({ truth: TRUTH, segments, explained: segments, matches: [hit(10, 1), hit(11, 2)] },
    { gapMm: 8 }, PARTS);
  assert.equal(row.overlapPx, 100);
});

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
