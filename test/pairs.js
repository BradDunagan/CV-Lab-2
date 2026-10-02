'use strict';

/**
 * Two close edges, placed jointly against the pixels.
 *
 * Pure JavaScript — no addon, no Electron. Every image here is built by
 * clipping each pixel's square against the scene's two lines and weighing the
 * three levels by AREA, which is what a pixel reports and shares no code with
 * the model under test: `coverage` integrates a trapezoid, the fixture clips a
 * polygon. So "the fit recovers the gap" is a statement about the gap that was
 * drawn, not about what the code produces.
 *
 *   node test/pairs.js
 */

const assert = require('node:assert/strict');
const {
  fitPairs, pairFrame, loneFrame, bandSamples, fitBand, measureAperture,
  coverage, density, solve, DEFAULTS,
} = require('../src/lab/pairs');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual}, expected ${expected} ± ${tol}`);

/* ---- the fixture ---------------------------------------------------- */

/** Area of a convex polygon. */
function area(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/** The part of a convex polygon where nx*x + ny*y >= c. */
function clip(poly, nx, ny, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = nx * p[0] + ny * p[1] - c, dq = nx * q[0] + ny * q[1] - c;
    if (dp >= 0) out.push(p);
    if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
      const s = dp / (dp - dq);
      out.push([p[0] + s * (q[0] - p[0]), p[1] + s * (q[1] - p[1])]);
    }
  }
  return out;
}

/** A line through (px, py) at `deg` from horizontal: unit normal and offset. */
function lineAt(px, py, deg) {
  const r = (deg * Math.PI) / 180;
  const nx = -Math.sin(r), ny = Math.cos(r);
  return { nx, ny, c: nx * px + ny * py, px, py, ux: Math.cos(r), uy: Math.sin(r) };
}

/**
 * A w x h raster of three levels separated by two lines: `below` where a
 * point is on the near side of `lo`, `above` beyond `hi`, `strip` between.
 * Pixel i's centre is at i, as everywhere in the lab, and it averages over a
 * square `aperture` px on a side.
 */
function strip(w, h, lo, hi, [below, mid, above], noise = 0, aperture = 1) {
  const data = new Float32Array(w * h);
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = aperture / 2, whole = aperture * aperture;
      const sq = [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
      const aAbove = area(clip(sq, hi.nx, hi.ny, hi.c)) / whole;
      const aBelow = 1 - area(clip(sq, lo.nx, lo.ny, lo.c)) / whole;
      data[y * w + x] = below * aBelow + above * aAbove + mid * (1 - aBelow - aAbove) + noise * rand();
    }
  }
  return { width: w, height: h, channels: 1, data };
}

/** A segment along `l` from t0 to t1, pushed `off` px along its normal. */
function segOn(id, l, t0, t1, off = 0) {
  const at = (t) => [l.px + l.ux * t + l.nx * off, l.py + l.uy * t + l.ny * off];
  const [x0, y0] = at(t0), [x1, y1] = at(t1);
  return { type: 'edge-segment', id, x0, y0, x1, y1 };
}

/** Where a fitted edge crosses the normal of `l` through its point at t. */
function offsetFrom(l, edge, t = 0) {
  const qx = l.px + l.ux * t, qy = l.py + l.uy * t;
  const dx = edge.x1 - edge.x0, dy = edge.y1 - edge.y0;
  // Solve edge.p0 + s*d = q + k*n for k.
  const det = dx * -l.ny - dy * -l.nx;
  return (dx * (qy - edge.y0) - dy * (qx - edge.x0)) / det;
}

const LEVELS = [0.6, 0.12, 0.31];

/** The standard scene: two parallel edges at 8 degrees, `gap` px apart. */
function scene(gap, { noise = 0, deg = 8, levels = LEVELS, aperture = 1 } = {}) {
  const lo = lineAt(80, 60, deg);
  const hi = lineAt(80 + lo.nx * gap, 60 + lo.ny * gap, deg);
  return { lo, hi, raster: strip(160, 120, lo, hi, levels, noise, aperture) };
}

/* ---- coverage ------------------------------------------------------- */

test('coverage is the area of the pixel beyond the step, at every angle', () => {
  for (const deg of [0, 3, 8, 30, 45, 60, 87, 90]) {
    const l = lineAt(0, 0, deg);
    const a = Math.min(Math.abs(l.nx), Math.abs(l.ny)) / 2, b = Math.max(Math.abs(l.nx), Math.abs(l.ny)) / 2;
    for (let d = -1; d <= 1; d += 0.0625) {
      // A pixel centred d beyond the step: the step is at n.p = -d.
      const sq = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
      near(coverage(d, a, b), area(clip(sq, l.nx, l.ny, -d)), 1e-12, `${deg} deg, d=${d}`);
    }
  }
});

test('a pixel centred on a step is half each side, and coverage is symmetric about it', () => {
  for (const [a, b] of [[0, 0.5], [0.07, 0.495], [0.3536, 0.3536]]) {
    assert.equal(coverage(0, a, b), 0.5);
    for (const d of [0.1, 0.33, 0.6, 2]) near(coverage(d, a, b) + coverage(-d, a, b), 1, 1e-15, `d=${d}`);
  }
});

test('density is the slope of coverage', () => {
  for (const [a, b] of [[0, 0.5], [0.07, 0.495], [0.25, 0.43]]) {
    for (let d = -0.9; d <= 0.9; d += 0.11) {
      const slope = (coverage(d + 1e-6, a, b) - coverage(d - 1e-6, a, b)) / 2e-6;
      near(density(d, a, b), slope, 1e-5, `a=${a} d=${d}`);
    }
  }
});

test('solve inverts a system that needs pivoting, and refuses a singular one', () => {
  const b = [2, 3];
  assert.equal(solve([[0, 1], [1, 1]], b), true);
  assert.deepEqual(b, [1, 2]);
  assert.equal(solve([[1, 2], [2, 4]], [1, 2]), false);
});

/* ---- the fit -------------------------------------------------------- */

test('two edges detected 0.6 px too far apart each come back to where they were drawn', () => {
  const { lo, hi, raster } = scene(2.3);
  // What blur does: each detection pushed away from the other.
  const [p] = fitPairs([segOn(1, lo, -50, 50, -0.6), segOn(2, hi, -40, 40, 0.6)], raster);
  assert.ok(p, 'no pair');
  near(p.gap, 2.3, 1e-4, 'gap');
  near(p.detectedGap, 3.5, 1e-9, 'detected gap');
  near(offsetFrom(lo, p.a), 0, 1e-4, 'edge a against the line it was drawn on');
  near(offsetFrom(hi, p.b), 0, 1e-4, 'edge b against the line it was drawn on');
  near(p.a.shift, 0.6, 1e-4, 'a moved toward b');
  near(p.b.shift, -0.6, 1e-4, 'b moved toward a');
  p.levels.forEach((v, k) => near(v, LEVELS[k], 1e-4, `level ${k}`));
  assert.equal(p.converged, true);
});

test('it holds at a tenth of a pixel, and at every orientation', () => {
  for (const deg of [0, 8, 45, 82, 90, 135]) {
    for (const gap of [1.7, 2.3, 4.6]) {
      const { lo, hi, raster } = scene(gap, { deg });
      const [p] = fitPairs([segOn(1, lo, -40, 40, -0.5), segOn(2, hi, -40, 40, 0.4)], raster);
      assert.ok(p, `no pair at ${deg} deg, gap ${gap}`);
      near(p.gap, gap, 1e-3, `${deg} deg, gap ${gap}`);
    }
  }
});

test('edges that converge are each fitted as their own line', () => {
  const lo = lineAt(80, 60, 8);
  const hi = lineAt(80 + lo.nx * 2.5, 60 + lo.ny * 2.5, 8.2); // 0.28 px closer over 80 px
  const raster = strip(160, 120, lo, hi, LEVELS);
  const [p] = fitPairs([segOn(1, lo, -40, 40, -0.5), segOn(2, hi, -40, 40, 0.5)], raster);
  for (const t of [-30, 0, 30]) {
    near(offsetFrom(lo, p.a, t), 0, 1e-3, `a at t=${t}`);
    near(offsetFrom(hi, p.b, t), 0, 1e-3, `b at t=${t}`);
  }
});

test('the record does not depend on which way a segment was written, or their order', () => {
  const { lo, hi, raster } = scene(2.3, { noise: 0.02 });
  const a = segOn(1, lo, -50, 50, -0.6), b = segOn(2, hi, -40, 40, 0.6);
  const flip = (s) => ({ ...s, x0: s.x1, y0: s.y1, x1: s.x0, y1: s.y0 });
  const expected = fitPairs([a, b], raster);
  assert.deepEqual(fitPairs([b, a], raster), expected);
  assert.deepEqual(fitPairs([flip(a), b], raster), expected);
  assert.deepEqual(fitPairs([a, flip(b)], raster), expected);
});

test('a strip brighter than both sides, or between them, is fitted as well as a dark one', () => {
  for (const levels of [[0.2, 0.7, 0.3], [0.1, 0.4, 0.8]]) {
    const { lo, hi, raster } = scene(2.6, { levels });
    const [p] = fitPairs([segOn(1, lo, -40, 40, -0.4), segOn(2, hi, -40, 40, 0.4)], raster);
    near(p.gap, 2.6, 1e-3, `levels ${levels}`);
  }
});

/* ---- what the pixels do not determine ------------------------------- */

test('a narrow strip is less determined than a wide one, and the record says so', () => {
  const read = (gap) => {
    const { lo, hi, raster } = scene(gap, { noise: 0.04 });
    return fitPairs([segOn(1, lo, -50, 50, -0.3), segOn(2, hi, -50, 50, 0.3)], raster)[0];
  };
  const wide = read(3), narrow = read(0.8);
  assert.ok(wide && narrow, 'no pair');
  assert.ok(narrow.gapSigma > 1.5 * wide.gapSigma,
    `sigma ${narrow.gapSigma} at 0.8 px against ${wide.gapSigma} at 3 px`);
  near(wide.gap, 3, 3 * wide.gapSigma + 0.01, 'the wide gap');
});

test('holding the strip at its true level determines a gap narrower than a pixel', () => {
  const { lo, hi, raster } = scene(0.8, { noise: 0.04 });
  const segs = [segOn(1, lo, -50, 50, -0.3), segOn(2, hi, -50, 50, 0.3)];
  const [free] = fitPairs(segs, raster);
  const [held] = fitPairs(segs, raster, { strip: 'held', stripLevel: LEVELS[1] });
  near(held.gap, 0.8, 0.03, 'gap with the level held');
  assert.equal(held.levels[1], LEVELS[1]);
  assert.equal(held.strip, 'held');
  assert.ok(free.gapSigma > 1.5 * held.gapSigma, `free ${free.gapSigma}, held ${held.gapSigma}`);
});

test('holding the strip at the WRONG level moves the gap, the way width and level trade', () => {
  // The image fixes (level drop) x (width). A strip held darker than it is
  // must come back narrower, by about that ratio.
  const { lo, hi, raster } = scene(0.8);
  const segs = [segOn(1, lo, -50, 50, -0.3), segOn(2, hi, -50, 50, 0.3)];
  const [darker] = fitPairs(segs, raster, { strip: 'held', stripLevel: 0.02 });
  assert.ok(darker.gap < 0.7, `held darker, the gap read ${darker.gap}`);
});

/* ---- the aperture --------------------------------------------------- */

test('a lone slanted segment returns the aperture its image was drawn through', () => {
  for (const drawn of [1, 1.5]) {
    const lo = lineAt(80, 60, 8), far = lineAt(80, 400, 8);
    const raster = strip(160, 120, lo, far, [0.6, 0.2, 0.2], 0.01, drawn);
    const m = measureAperture([segOn(1, lo, -50, 50, 0.4)], raster, new Set(), DEFAULTS);
    assert.ok(m, 'nothing measured');
    near(m.width, drawn, 0.03, `drawn through ${drawn}`);
    assert.equal(m.segments, 1);
  }
});

test('an axis-aligned segment says nothing about the aperture, and a short one is not asked', () => {
  const lo = lineAt(80, 60.3, 0), far = lineAt(80, 400, 0);
  const raster = strip(160, 120, lo, far, [0.6, 0.2, 0.2], 0.01);
  assert.equal(measureAperture([segOn(1, lo, -50, 50, 0.4)], raster, new Set(), DEFAULTS), null);
  const slanted = lineAt(80, 60, 8);
  const r2 = strip(160, 120, slanted, far, [0.6, 0.2, 0.2], 0.01);
  assert.equal(measureAperture([segOn(1, slanted, -8, 8)], r2, new Set(), DEFAULTS), null);
});

test('a soft shadow edge among the lone segments does not set the aperture', () => {
  // Four segments on one sharp step, and one on a step drawn four times softer.
  const lo = lineAt(80, 40, 8), far = lineAt(80, 400, 8);
  const sharp = strip(160, 120, lo, far, [0.6, 0.2, 0.2], 0.01, 1);
  const soft = strip(160, 120, lineAt(80, 90, 8), far, [0.2, 0.1, 0.1], 0, 4);
  // One image: the sharp step in its top half, the soft one in its bottom half.
  const data = new Float32Array(160 * 120);
  for (let i = 0; i < data.length; i++) data[i] = i < 160 * 65 ? sharp.data[i] : soft.data[i];
  const raster = { width: 160, height: 120, channels: 1, data };
  const segs = [
    segOn(1, lo, -70, -40), segOn(2, lo, -35, -5), segOn(3, lo, 5, 35), segOn(4, lo, 40, 70),
    segOn(5, lineAt(80, 90, 8), -50, 50),
  ];
  const m = measureAperture(segs, raster, new Set(), DEFAULTS);
  assert.equal(m.segments, 5);
  near(m.width, 1, 0.1, 'aperture');
});

test('a pair is fitted through the aperture measured beside it, and the record says where it came from', () => {
  const drawn = 1.4;
  const lo = lineAt(80, 60, 8);
  const hi = lineAt(80 + lo.nx * 1.2, 60 + lo.ny * 1.2, 8);
  const raster = strip(160, 120, lo, hi, LEVELS, 0.005, drawn);
  // A lone step elsewhere in the same image: its bottom rows, repainted.
  const lone = lineAt(80, 100, -6), far = lineAt(80, 400, -6);
  const below = strip(160, 120, lone, far, [LEVELS[2], 0.05, 0.05], 0.005, drawn);
  for (let i = 160 * 85; i < raster.data.length; i++) raster.data[i] = below.data[i];

  const pair = [segOn(1, lo, -50, 50, -0.4), segOn(2, hi, -50, 50, 0.4)];
  const [measured] = fitPairs([...pair, segOn(3, lone, -50, 50, 0.3)], raster);
  assert.equal(measured.apertureFrom, 'segments');
  assert.equal(measured.apertureSegments, 1);
  near(measured.aperture, drawn, 0.05, 'aperture');
  near(measured.gap, 1.2, 0.05, 'gap, through the measured aperture');

  // With no lone segment there is nothing to measure it on.
  const [assumed] = fitPairs(pair, raster);
  assert.equal(assumed.apertureFrom, 'default');
  assert.equal(assumed.aperture, DEFAULTS.apertureWidth);
  assert.ok(Math.abs(assumed.gap - 1.2) > 2 * Math.abs(measured.gap - 1.2),
    `assuming 1 read ${assumed.gap}, measuring read ${measured.gap}`);

  const [held] = fitPairs(pair, raster, { aperture: 'held', apertureWidth: drawn });
  assert.equal(held.apertureFrom, 'held');
  near(held.gap, 1.2, 0.05, 'gap, aperture held at the truth');
});

test('one step on its own is placed where it was drawn', () => {
  const lo = lineAt(80, 60, 8), far = lineAt(80, 400, 8);
  const raster = strip(160, 120, lo, far, [0.6, 0.2, 0.2]);
  const frame = loneFrame(segOn(1, lo, -50, 50, 0.7), DEFAULTS);
  const fit = fitBand(bandSamples(raster, frame, DEFAULTS), frame, { aperture: 1 });
  near(fit.edges[0].c, -0.7, 1e-4, 'offset back to the drawn line');
  near(fit.levels[0], 0.6, 1e-4, 'below'); near(fit.levels[1], 0.2, 1e-4, 'above');
  assert.equal(fit.gapSigma, null);
});

/* ---- what is not a pair --------------------------------------------- */

test('segments too far apart, too far from parallel, or not overlapping are left alone', () => {
  const { lo, hi, raster } = scene(2.3);
  const a = segOn(1, lo, -50, 50);
  assert.equal(fitPairs([a, segOn(2, hi, -40, 40, 5)], raster).length, 0, 'beyond maxGap');
  assert.equal(fitPairs([a, segOn(2, hi, 60, 100)], raster).length, 0, 'no overlap');
  assert.equal(fitPairs([a, segOn(2, hi, 44, 56)], raster).length, 0, 'overlap under minOverlap');
  const tilted = lineAt(hi.px, hi.py, 8 + DEFAULTS.maxAngle + 1);
  assert.equal(fitPairs([a, segOn(2, tilted, -10, 10)], raster).length, 0, 'beyond maxAngle');
  assert.equal(fitPairs([a, segOn(2, hi, -40, 40)], raster, { maxGap: 2 }).length, 0, 'maxGap is a parameter');
});

test('two detections of ONE step are not a pair: there is no strip between them', () => {
  // One edge, found twice a pixel and a half apart -- fragments that `merge`
  // left separate, say. The image has a single step and no third level.
  const lo = lineAt(80, 60, 8);
  const far = lineAt(80 + lo.nx * 40, 60 + lo.ny * 40, 8);
  const raster = strip(160, 120, lo, far, [0.6, 0.2, 0.2], 0.01);
  const pairs = fitPairs([segOn(1, lo, -50, 50, -0.7), segOn(2, lo, -40, 40, 0.8)], raster);
  assert.equal(pairs.length, 0, `described one step as ${JSON.stringify(pairs[0])}`);
});

test('only segments are paired, and the input is not touched', () => {
  const { lo, hi, raster } = scene(2.3);
  const input = [
    segOn(1, lo, -50, 50, -0.6), segOn(2, hi, -40, 40, 0.6),
    { type: 'edge-corner', id: 1, x: 80, y: 60 },
    { type: 'edge-arc', id: 3, x0: 30, y0: 53, x1: 130, y1: 67, cx: 80, cy: 500, r: 440 },
  ];
  const before = JSON.stringify(input);
  const out = fitPairs(input, raster);
  assert.equal(out.length, 1);
  assert.equal(JSON.stringify(input), before);
});

test('pairs are numbered from 1 in order of their segments\' ids, whatever order they arrive in', () => {
  // Three parallel edges 5 px apart, on pixel boundaries: the two neighbouring
  // pairs are pairs, and the outer two are too far apart to be one.
  const l1 = lineAt(80, 39.5, 0), l2 = lineAt(80, 44.5, 0), l3 = lineAt(80, 49.5, 0);
  const raster = { width: 160, height: 120, channels: 1, data: new Float32Array(160 * 120) };
  for (let y = 0; y < 120; y++) {
    for (let x = 0; x < 160; x++) raster.data[y * 160 + x] = y < 40 ? 0.1 : y < 45 ? 0.5 : y < 50 ? 0.2 : 0.7;
  }
  const segs = [segOn(7, l3, -40, 40, 0.3), segOn(2, l1, -40, 40, 0.3), segOn(5, l2, -40, 40, 0.3)];
  const out = fitPairs(segs, raster, { pad: 3 });
  assert.deepEqual(out.map((p) => [p.id, p.a.segment, p.b.segment]), [[1, 2, 5], [2, 5, 7]]);
});

test('a pair at the image border is fitted over the pixels that exist', () => {
  const lo = lineAt(80, 2, 0), hi = lineAt(80, 4.4, 0);
  const raster = strip(160, 40, lo, hi, LEVELS);
  const [p] = fitPairs([segOn(1, lo, -40, 40, -0.4), segOn(2, hi, -40, 40, 0.5)], raster);
  assert.ok(p, 'no pair');
  near(p.gap, 2.4, 1e-3, 'gap');
});

test('the frame puts the longer segment on its own axis and the other across it', () => {
  const a = { type: 'edge-segment', id: 1, x0: 0, y0: 10, x1: 100, y1: 10 };
  const b = { type: 'edge-segment', id: 2, x0: 20, y0: 13, x1: 80, y1: 13 };
  const f = pairFrame(a, b, DEFAULTS);
  assert.deepEqual([f.ux, f.uy, f.nx, f.ny], [1, 0, -0, 1]);
  assert.deepEqual([f.ox, f.oy], [50, 10]);
  assert.equal(f.half, 30 - DEFAULTS.inset);
  assert.deepEqual(f.edges, [{ id: 1, c: 0, m: 0 }, { id: 2, c: 3, m: 0 }]);
});

(async () => {
  // An ES module, so it is imported rather than required, and this is last.
  const { overlayRole, isDetection } = await import('../src/renderer/overlay-features.mjs');
  test('a pair is a feature type the tile overlay knows, with nothing of its own to draw', () => {
    assert.equal(overlayRole({ type: 'edge-pair' }), 'none');
    assert.equal(isDetection({ type: 'edge-pair' }), false);
  });

  if (failures > 0) {
    console.error(`\n${failures} pair test(s) FAILED.`);
    process.exit(1);
  }
  console.log('\nAll pair tests passed.');
})();
