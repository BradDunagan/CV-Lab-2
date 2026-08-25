'use strict';

/**
 * Corner hypotheses from fitted segments.
 *
 * Pure JavaScript — no addon, no Electron. Segments are constructed by hand so
 * the geometry under test is exact and the expected answer is arithmetic
 * rather than "whatever came out".
 *
 *   node test/corners.js
 */

const assert = require('node:assert/strict');
const { findCorners } = require('../src/lab/corners');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

/** A fitted segment, as `fit` would report one. */
const seg = (id, x0, y0, x1, y1, { rms = 0.2, pixels = null } = {}) => {
  const length = Math.hypot(x1 - x0, y1 - y0);
  return { id, x0, y0, x1, y1, length, rms, residual: rms * 2,
           pixels: pixels ?? Math.max(2, Math.round(length)),
           angle: 0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
};
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('cv-lab-2 corner tests');

/* --- the basic geometry ------------------------------------------------ */

test('two segments that already meet give a corner with no reach', () => {
  const c = findCorners([seg(1, 0, 40, 40, 40), seg(2, 40, 40, 40, 80)]);
  assert.equal(c.length, 1);
  assert.ok(close(c[0].x, 40, 1e-6) && close(c[0].y, 40, 1e-6), `${c[0].x},${c[0].y}`);
  assert.ok(c[0].reach <= 0.001, `reach should be ~0, got ${c[0].reach}`);
  assert.ok(close(c[0].angle, 90, 1e-6));
});

test('segments stopping short still find the corner, and report the reach', () => {
  // The case the whole design exists for: blur, nms and thresholding all make
  // real edges stop before the corner they belong to.
  const c = findCorners([seg(1, 0, 40, 35, 40), seg(2, 40, 45, 40, 80)]);
  assert.equal(c.length, 1);
  assert.ok(close(c[0].x, 40, 1e-6) && close(c[0].y, 40, 1e-6));
  assert.ok(close(c[0].reach, 5, 1e-6), `reach should be 5, got ${c[0].reach}`);
});

test('an intersection inside both segments reports a negative reach', () => {
  // A genuine crossing, not an extrapolation: the strongest case there is.
  const c = findCorners([seg(1, 0, 40, 80, 40), seg(2, 40, 0, 40, 80)]);
  assert.equal(c.length, 1);
  assert.ok(c[0].reach < 0, `crossing should read as negative reach, got ${c[0].reach}`);
});

/* --- the guards -------------------------------------------------------- */

test('near-parallel segments are refused', () => {
  // Their intersection is far away and its position explodes as 1/sin(angle).
  //
  // maxReachRatio is held wide open in both calls so that only the angle guard
  // is under test. With the default cap these are rejected for being 1140px
  // away instead, which would have made this pass for the wrong reason.
  const shallow = [seg(1, 0, 40, 60, 40), seg(2, 0, 60, 60, 59)];
  assert.equal(findCorners(shallow, { minAngle: 15, maxReachRatio: 1000 }).length, 0);
  assert.equal(findCorners(shallow, { minAngle: 0.5, maxReachRatio: 1000 }).length, 1,
    'they should be found once the angle guard is relaxed');
});

test('the two guards are independent', () => {
  // A wide angle but an absurd reach, and a tiny angle but a short reach:
  // each must be rejected by its own guard and by neither the other.
  const wideAngleFarAway = [seg(1, 0, 40, 20, 40), seg(2, 300, 41, 300, 200)];
  assert.equal(findCorners(wideAngleFarAway, { minAngle: 15, maxReachRatio: 2 }).length, 0,
    'rejected by reach');
  assert.equal(findCorners(wideAngleFarAway, { minAngle: 15, maxReachRatio: 1000 }).length, 1,
    'accepted once the reach cap allows it');
});

test('reach is capped as a ratio of length, not a pixel count', () => {
  // Reaching 30px off a 60px segment is an extension of half its own length;
  // off a 6px stub it is five times. A fixed pixel threshold cannot tell those
  // apart, which is why the cap is scale-free.
  const long = [seg(1, 0, 40, 60, 40), seg(2, 90, 41, 90, 100)];
  const stub = [seg(1, 54, 40, 60, 40), seg(2, 90, 41, 90, 100)];
  assert.equal(findCorners(long, { maxReachRatio: 1 }).length, 1);
  assert.equal(findCorners(stub, { maxReachRatio: 1 }).length, 0);
});

test('fewer than two segments yields nothing', () => {
  assert.deepEqual(findCorners([]), []);
  assert.deepEqual(findCorners([seg(1, 0, 0, 10, 10)]), []);
});

/* --- corroboration ------------------------------------------------------ */

test('three segments meeting at a point cluster into one corner', () => {
  // A cube vertex. Three pairs predict the same place, and that agreement is
  // evidence no single pair provides.
  const c = findCorners([
    seg(1, 0, 50, 45, 50),
    seg(2, 50, 0, 50, 45),
    seg(3, 85, 85, 55, 55),
  ]);
  assert.equal(c.length, 1, `expected one clustered corner, got ${c.length}`);
  assert.equal(c[0].support, 3);
  assert.deepEqual(c[0].segments, [1, 2, 3]);
  assert.ok(close(c[0].x, 50, 0.5) && close(c[0].y, 50, 0.5), `${c[0].x},${c[0].y}`);
});

test('distinct corners are not merged', () => {
  const c = findCorners([
    seg(1, 0, 20, 60, 20),
    seg(2, 20, 0, 20, 60),
    seg(3, 200, 220, 260, 220),
    seg(4, 220, 200, 220, 260),
  ]);
  assert.equal(c.length, 2);
  assert.ok(c.every((k) => k.support === 1));
});

test('results are ordered by evidence: support first, then tightness', () => {
  const c = findCorners([
    seg(1, 0, 50, 45, 50), seg(2, 50, 0, 50, 45), seg(3, 85, 85, 55, 55),
    seg(4, 200, 20, 260, 20), seg(5, 220, 0, 220, 60),
  ]);
  assert.equal(c[0].support, 3, 'the three-way agreement should come first');
  for (let i = 1; i < c.length; i++) {
    assert.ok(c[i - 1].support > c[i].support ||
      (c[i - 1].support === c[i].support && c[i - 1].sigma <= c[i].sigma + 1e-9),
      'ordering is not by support then sigma');
  }
});

/* --- endpointGap: did the edges actually stop near each other? ----------- */

test('endpointGap is small when both edges stop near the same place', () => {
  // A corner eroded by blur and nms: both edges terminate a few pixels short
  // of it, so their ends stay close to each other.
  const c = findCorners([seg(1, 0, 40, 35, 40), seg(2, 40, 45, 40, 80)])[0];
  assert.ok(c.endpointGap < 8, `expected a small gap, got ${c.endpointGap}`);
});

test('endpointGap is large for two unrelated lines that merely intersect', () => {
  const c = findCorners([seg(1, 0, 40, 20, 40), seg(2, 200, 60, 200, 140)],
    { maxReachRatio: 100 })[0];
  assert.ok(c.endpointGap > 100, `expected a large gap, got ${c.endpointGap}`);
});

test('endpointGap can be small while reach is large', () => {
  // The case that makes it a better discriminator than reach. Two long edges
  // both ending near a corner give a small gap; but if the corner lies past
  // the FAR end of one of them, its nearest-endpoint reach is large. On the
  // cube two genuine three-way vertices had reaches of 33.2 and 22.2 -- inside
  // the range of the spurious candidates -- while their endpoint gaps were
  // 1.3 and 1.6, against 49-65 for every spurious one.
  const c = findCorners([
    seg(1, 0, 40, 30, 40),      // ends at (30,40)
    seg(2, 33, 43, 33, 120),    // ends at (33,43): 4.2px away
  ], { maxReachRatio: 100 })[0];
  assert.ok(c.endpointGap < 6, `gap should be small, got ${c.endpointGap}`);
});

test('every corner reports endpointGap', () => {
  const c = findCorners([seg(1, 0, 50, 45, 50), seg(2, 50, 0, 50, 45), seg(3, 85, 85, 55, 55)]);
  assert.ok(c.every((k) => typeof k.endpointGap === 'number' && k.endpointGap >= 0));
});

/* --- the uncertainty model ---------------------------------------------- */

test('sigma grows with how far the lines had to reach', () => {
  const near = findCorners([seg(1, 0, 40, 35, 40), seg(2, 40, 45, 40, 80)],
    { maxReachRatio: 10 })[0];
  const far = findCorners([seg(1, 0, 40, 10, 40), seg(2, 40, 70, 40, 80)],
    { maxReachRatio: 10 })[0];
  assert.ok(far.sigma > near.sigma * 3,
    `reaching further should cost accuracy: ${near.sigma} -> ${far.sigma}`);
});

test('sigma grows when the fit is noisier or shorter', () => {
  const base = findCorners([seg(1, 0, 40, 10, 40), seg(2, 40, 70, 40, 80)],
    { maxReachRatio: 10 })[0];
  const noisy = findCorners([
    seg(1, 0, 40, 10, 40, { rms: 0.9 }), seg(2, 40, 70, 40, 80, { rms: 0.9 }),
  ], { maxReachRatio: 10 })[0];
  const stubby = findCorners([
    seg(1, 2, 40, 10, 40, { pixels: 9 }), seg(2, 40, 70, 40, 78, { pixels: 9 }),
  ], { maxReachRatio: 10 })[0];
  assert.ok(noisy.sigma > base.sigma, 'a noisier fit should be less certain');
  assert.ok(stubby.sigma > base.sigma, 'a shorter fit should be less certain');
});

test('sigma measures precision, not correctness', () => {
  // Recorded because it is the thing most likely to be misread. Two long,
  // clean, well-determined lines extended a long way still intersect
  // PRECISELY -- somewhere that is not a corner. On the cube every one of the
  // fourteen candidates, including nonsense at 92px reach, came out under one
  // pixel of sigma. Reach and support are what separate real from invented;
  // sigma says how well-located the answer is once you believe it.
  const absurd = findCorners([
    seg(1, 0, 40, 60, 40), seg(2, 300, 41, 300, 200),
  ], { maxReachRatio: 100 })[0];
  assert.ok(absurd.reach > 200, `expected a long reach, got ${absurd.reach}`);
  assert.ok(absurd.sigma < 1, `and yet a tight sigma, got ${absurd.sigma}`);
});

/* --- typing -------------------------------------------------------------- */

test('every corner is tagged edge-corner', () => {
  // Namespaced so that a future region- or flow- feature cannot collide with
  // an edge one just by both being called "corner".
  const c = findCorners([seg(1, 0, 40, 40, 40), seg(2, 40, 40, 40, 80)]);
  assert.ok(c.every((k) => k.type === 'edge-corner'));
});

/* --- determinism -------------------------------------------------------- */

test('corners is deterministic and independent of input order', () => {
  const s = [
    seg(1, 0, 50, 45, 50), seg(2, 50, 0, 50, 45), seg(3, 85, 85, 55, 55),
    seg(4, 200, 20, 260, 20), seg(5, 220, 0, 220, 60),
  ];
  const once = findCorners(s);
  for (let i = 0; i < 3; i++) assert.deepEqual(findCorners(s), once);

  // Reversing the segment list must not change which corners are found or
  // where they are — only the arbitrary ids attached to them.
  const reversed = findCorners([...s].reverse());
  const key = (c) => `${c.x.toFixed(6)},${c.y.toFixed(6)},${c.support}`;
  assert.deepEqual(reversed.map(key).sort(), once.map(key).sort());
});

console.log(failures === 0 ? '\nAll corner tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
