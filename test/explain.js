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
  viewGeometry, slantAt,
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

/* --- slant, which v1 could not tell from a step ---------------------- */

const CAMERA = { fov: 50 };

/*
 * These fixtures are 128 px rather than 32. At 32 px with a 50° field of view
 * the focal length is 34 px, so five pixels spans a sixth of the frame and the
 * depth of a grazing plane runs 1.4 m to 3.4 m across it -- bilinear sampling
 * of a curve that steep is 60 mm out on its own, which would be read here as a
 * residual the correction failed to explain. The fixture has to be finer than
 * the effect it is measuring.
 */
const S = 128;
const CENTRE = { type: 'edge-segment', id: 1, x0: S / 2, y0: S / 2 - 10, x1: S / 2, y1: S / 2 + 10 };

const raster = (channels, fill) => {
  const data = new Float32Array(S * S * channels);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = fill(x, y);
      for (let c = 0; c < channels; c++) data[(y * S + x) * channels + c] = v[c] ?? 0;
    }
  }
  return { width: S, height: S, channels, data };
};

/**
 * A depth pass for one flat surface, built from the geometry `explain` uses to
 * predict one: `z = c / (n·e)`.
 *
 * Constructed rather than recorded. A fixture pasted in from a renderer could
 * not say whether the code or the numbers were wrong, and the claim under test
 * is a property — a plane is exactly what slant accounts for — so the fixture
 * is that property, written out.
 */
function slantedPlane(normal, zCentre, stepBeyondMiddle = 0) {
  const g = viewGeometry(CAMERA, S, S);
  const e = (x, y) => [(x - g.cx) / g.f, -(y - g.cy) / g.f, -1];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const mid = e(S / 2, S / 2);
  const c = dot(normal, [mid[0] * zCentre, mid[1] * zCentre, -zCentre]);
  return raster(1, (x, y) => [c / dot(normal, e(x, y)) + (x >= S / 2 ? stepBeyondMiddle : 0)]);
}

/** 80° from the line of sight: nearly edge-on, as a curved surface is at its rim. */
const GRAZING = [Math.sin((80 * Math.PI) / 180), 0, Math.cos((80 * Math.PI) / 180)];
const grazingPass = () => raster(3, () => packNormal(GRAZING));
const facingPass = () => raster(3, () => FACING);
const greyPass = () => raster(3, () => [0.5, 0.5, 0.5]);

const scene = ({ depth, normal, albedo, camera }) => ({
  depth: { width: S, height: S, channels: 1, data: depth.data },
  normal, albedo, camera,
});

test('slant is measured from the line of sight, not from the image plane', () => {
  const g = viewGeometry(CAMERA, S, S);
  assert.ok(Math.abs(slantAt(g, facingPass(), S / 2, S / 2)) < 1e-6,
    'a surface facing the camera is not at zero slant');
  const grazed = slantAt(g, grazingPass(), S / 2, S / 2);
  assert.ok(Math.abs(grazed - 80) < 0.5, `an 80° surface measured ${grazed.toFixed(1)}°`);
});

test('a receding surface is not an occlusion, however large the difference', () => {
  /*
   * The v1 defect, as a test. At 80° the surface drops 0.4 m across five
   * pixels -- twenty times the threshold -- with nothing in front of anything.
   * 241 of the 282 `occlusion` calls on the helmet were this.
   */
  const r = explainFeature(CENTRE, scene({
    depth: slantedPlane(GRAZING, 2.0),
    normal: grazingPass(),
    albedo: greyPass(),
    camera: CAMERA,
  }));
  assert.ok(r.depthStep > 0.2, `the fixture does not exercise it: ${r.depthStep}`);
  assert.ok(r.depthExcess < 0.005, `a plane left ${r.depthExcess} m unexplained`);
  assert.equal(r.cause, 'shading');
});

test('a real step is still an occlusion, and the correction leaves it alone', () => {
  // Same sampling, same threshold: what changed is only what gets subtracted.
  const r = explainFeature(CENTRE, scene({
    depth: raster(1, (x) => [x < S / 2 ? 1.0 : 1.5]),
    normal: facingPass(),
    albedo: greyPass(),
    camera: CAMERA,
  }));
  assert.equal(r.cause, 'occlusion');
  assert.ok(Math.abs(r.depthExcess - 0.5) < 1e-3, `excess ${r.depthExcess}`);
  assert.ok(r.planeStep < 1e-3, `a surface facing the camera explained ${r.planeStep} m`);
});

test('a step ON a receding surface is still found, by what the surface cannot explain', () => {
  // The case that says this subtracts rather than suppresses: a real 0.4 m
  // discontinuity added to a grazing plane that accounts for everything else.
  const r = explainFeature(CENTRE, scene({
    depth: slantedPlane(GRAZING, 2.0, 0.4),
    normal: grazingPass(),
    albedo: greyPass(),
    camera: CAMERA,
  }));
  assert.equal(r.cause, 'occlusion');
  assert.ok(Math.abs(r.depthExcess - 0.4) < 0.01, `excess ${r.depthExcess}, wanted 0.4`);
});

test('without a camera nothing is subtracted, and the record says which', () => {
  /*
   * `planeStep: 0` is the honest form of "not corrected". The operation refuses
   * to run without a field of view, precisely so v1's answer cannot arrive
   * under v2's version number -- but the function below it stays usable, and
   * says what it did.
   */
  const uncorrected = explainFeature(CENTRE, scene({
    depth: slantedPlane(GRAZING, 2.0),
    normal: grazingPass(),
    albedo: greyPass(),
    camera: null,
  }));
  assert.equal(uncorrected.planeStep, 0);
  assert.equal(uncorrected.depthExcess, uncorrected.depthStep);
  assert.equal(uncorrected.cause, 'occlusion', 'this is v1, and v1 was wrong here');
});

test('a field of view that cannot be one is refused rather than approximated', () => {
  for (const fov of [0, -50, 180, 'wide', undefined, null]) {
    assert.equal(viewGeometry({ fov }, S, S), null, `${fov} was accepted`);
  }
});

console.log(failures === 0 ? '\nAll explain tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
