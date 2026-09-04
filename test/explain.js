'use strict';

/**
 * What put an edge in the picture, from the renderer's auxiliary passes.
 *
 * Pure JavaScript — no addon, no Electron. Every raster here is built by hand,
 * one step down the middle, so the expected answer is arithmetic rather than
 * "whatever came out". A test that records what the code produces cannot tell
 * you the code is wrong.
 *
 *   node test/explain.js
 */

const assert = require('node:assert/strict');
const {
  explainFeature, explainFeatures, crossings, sample, normalAt, angleBetween, median,
} = require('../src/lab/explain');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const W = 32, H = 32;

/**
 * A raster with a vertical step down the middle: `left` for x < 16, `right`
 * otherwise. Every pass in these tests is one of these, so what changes across
 * the edge is exactly what the test says changes and nothing else.
 */
function step(channels, left, right) {
  const data = new Float32Array(W * H * channels);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = x < W / 2 ? left : right;
      for (let c = 0; c < channels; c++) data[(y * W + x) * channels + c] = v[c] ?? 0;
    }
  }
  return { width: W, height: H, channels, data };
}

const flat = (channels, v) => step(channels, v, v);

/** A vertical edge through the middle, as `fit` would report one. */
const vertical = { type: 'edge-segment', id: 1, x0: 16, y0: 6, x1: 16, y1: 26 };

/** Normals encoded the way a pass holds them: components mapped into [0,1]. */
const packNormal = (n) => n.map((v) => (v + 1) / 2);

const FACING = packNormal([0, 0, 1]);          // straight at the camera
const TURNED = packNormal([0.7071, 0, 0.7071]); // 45° away — a fold

/* --- the pieces, before the decision they feed ---------------------- */

test('a packed normal round-trips to a unit vector', () => {
  const raster = flat(3, TURNED);
  const n = normalAt(raster, 8, 8);
  assert.ok(Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-6, 'not unit length');
  assert.ok(Math.abs(n[0] - 0.7071) < 1e-3 && Math.abs(n[2] - 0.7071) < 1e-3,
    `decoded to ${n}`);
});

test('the angle between two normals is the angle between them', () => {
  assert.ok(Math.abs(angleBetween([0, 0, 1], [0, 0, 1])) < 1e-6);
  assert.ok(Math.abs(angleBetween([0, 0, 1], [1, 0, 0]) - 90) < 1e-6);
  assert.ok(Math.abs(angleBetween([0, 0, 1], [0.7071, 0, 0.7071]) - 45) < 1e-3);
});

test('a segment is crossed perpendicular, on both sides, inset from its ends', () => {
  const pairs = crossings(vertical, { offset: 2.5, samples: 3 });
  assert.equal(pairs.length, 3);
  for (const [a, b] of pairs) {
    /*
     * Perpendicular to a vertical edge is horizontal, 2.5 either side. WHICH
     * side is `a` depends on the direction the segment was fitted in, which
     * is arbitrary -- so the assertion is on the pair, not on the order.
     * Pinning the order would fail for the same edge drawn the other way.
     */
    assert.deepEqual([a.x, b.x].sort((p, q) => p - q).map((v) => Math.round(v * 10) / 10),
      [13.5, 18.5], `crossed at x=${a.x},${b.x} rather than either side`);
    assert.equal(a.y, b.y, 'the two samples are not opposite each other');
    // Inset: never the endpoints, which are where a fit overshoots.
    assert.ok(a.y > vertical.y0 && a.y < vertical.y1, `sampled at the end, y=${a.y}`);
  }
});

test('a segment fitted the other way round is crossed the same way', () => {
  const forward = crossings(vertical, { offset: 2.5, samples: 3 });
  const backward = crossings(
    { ...vertical, x0: vertical.x1, y0: vertical.y1, x1: vertical.x0, y1: vertical.y0 },
    { offset: 2.5, samples: 3 }
  );
  const xs = (pairs) => pairs.flatMap(([a, b]) => [a.x, b.x]).sort((p, q) => p - q);
  assert.deepEqual(xs(forward), xs(backward),
    'the direction of the fit changed where it was sampled');
});

test('a corner is crossed along four axes, being a point rather than a line', () => {
  const pairs = crossings({ type: 'edge-corner', x: 16, y: 16 }, { offset: 2, samples: 7 });
  assert.equal(pairs.length, 4);
  for (const [a, b] of pairs) {
    assert.ok(Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - 4) < 1e-3,
      'the pair is not 2 either side of the corner');
  }
});

test('the median ignores a minority of wild samples', () => {
  // Why a median and not a mean: a fitted segment overshoots its real extent,
  // so a few samples measure something else entirely.
  assert.equal(median([1, 1, 1, 1, 900]), 1);
  assert.equal(median([2, 4]), 3);
});

/* --- the decision --------------------------------------------------- */

const passes = ({ depth, normal, albedo }) => ({
  depth: { width: W, height: H, channels: 1, data: depth },
  normal, albedo,
});

/** A 1-channel depth raster in metres, stepping at the middle. */
function depthStep(near, far) {
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) data[y * W + x] = x < W / 2 ? near : far;
  }
  return data;
}

test('a depth step is an occlusion', () => {
  const r = explainFeature(vertical, passes({
    depth: depthStep(1.0, 1.5),
    normal: flat(3, FACING),
    albedo: flat(3, [0.5, 0.5, 0.5]),
  }));
  assert.equal(r.cause, 'occlusion');
  assert.ok(Math.abs(r.depthStep - 0.5) < 1e-5, `measured ${r.depthStep}`);
});

test('a normal step with no depth step is a crease', () => {
  const r = explainFeature(vertical, passes({
    depth: depthStep(1.0, 1.0),
    normal: step(3, FACING, TURNED),
    albedo: flat(3, [0.5, 0.5, 0.5]),
  }));
  assert.equal(r.cause, 'crease');
  assert.ok(Math.abs(r.normalStep - 45) < 0.5, `measured ${r.normalStep}°`);
});

test('an albedo step with neither is texture', () => {
  const r = explainFeature(vertical, passes({
    depth: depthStep(1.0, 1.0),
    normal: flat(3, FACING),
    albedo: step(3, [0.2, 0.2, 0.2], [0.8, 0.8, 0.8]),
  }));
  assert.equal(r.cause, 'texture');
  assert.ok(Math.abs(r.albedoStep - 0.6) < 1e-5, `measured ${r.albedoStep}`);
});

test('none of the three is shading, which is the answer this exists for', () => {
  // A shadow boundary: same surface, same distance, same paint. A real image
  // edge belonging to the light, which is why the detector finds it and why
  // ground truth is right to call it invented.
  const r = explainFeature(vertical, passes({
    depth: depthStep(1.0, 1.0),
    normal: flat(3, FACING),
    albedo: flat(3, [0.5, 0.5, 0.5]),
  }));
  assert.equal(r.cause, 'shading');
  assert.equal(r.depthStep, 0);
  assert.equal(r.normalStep, 0);
  assert.equal(r.albedoStep, 0);
});

test('depth wins over normal, because an occlusion has both', () => {
  /*
   * The order is the whole design. Two surfaces at different depths also face
   * different ways, so a silhouette shows a normal step too -- testing normal
   * first would report every silhouette as a crease.
   */
  const r = explainFeature(vertical, passes({
    depth: depthStep(1.0, 1.5),
    normal: step(3, FACING, TURNED),
    albedo: step(3, [0.2, 0.2, 0.2], [0.8, 0.8, 0.8]),
  }));
  assert.equal(r.cause, 'occlusion');
});

test('a pass that was not supplied makes the answer unknown, not shading', () => {
  // Reaching "shading" by not looking would be a confident wrong answer, and
  // shading is precisely the bucket this is meant to stop over-filling.
  const r = explainFeature(vertical, {
    depth: null,
    normal: flat(3, FACING),
    albedo: flat(3, [0.5, 0.5, 0.5]),
  });
  assert.equal(r.cause, 'unknown');
});

test('thresholds decide, and a step just under one is not a step', () => {
  const near = passes({
    depth: depthStep(1.0, 1.01),          // 10 mm
    normal: flat(3, FACING),
    albedo: flat(3, [0.5, 0.5, 0.5]),
  });
  assert.equal(explainFeature(vertical, near, { depthStep: 0.02 }).cause, 'shading');
  assert.equal(explainFeature(vertical, near, { depthStep: 0.005 }).cause, 'occlusion');
});

test('explaining a list does not mutate the features it was given', () => {
  // A features slot is content-hashed. A kernel that edited its input in place
  // would make two slots share one object, and one hash describe both.
  const input = [{ ...vertical }];
  const out = explainFeatures(input, passes({
    depth: depthStep(1.0, 1.0),
    normal: flat(3, FACING),
    albedo: flat(3, [0.5, 0.5, 0.5]),
  }));
  assert.equal(input[0].cause, undefined, 'the input was written to');
  assert.equal(out[0].cause, 'shading');
  assert.equal(out[0].id, vertical.id, 'the original fields did not survive');
});

test('bilinear sampling reads between pixels', () => {
  const r = step(1, [0], [1]);
  // The step is between x=15 and x=16, so x=15.5 is halfway across it.
  assert.ok(Math.abs(sample(r, 15.5, 8, 0) - 0.5) < 1e-6, `got ${sample(r, 15.5, 8, 0)}`);
  // And outside the raster it clamps rather than reading rubbish.
  assert.equal(sample(r, -5, 8, 0), 0);
  assert.equal(sample(r, 999, 8, 0), 1);
});

console.log(failures === 0 ? '\nAll explain tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
