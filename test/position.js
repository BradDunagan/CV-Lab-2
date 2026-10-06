'use strict';

/**
 * One relative position from several gap readings.
 *
 * Pure JavaScript. Every reading here is made from a displacement that was
 * chosen, through Jacobians that were chosen, so the expected answer is the
 * displacement and the expected sigmas are arithmetic.
 *
 *   node test/position.js
 */

const assert = require('node:assert/strict');
const { solvePosition, solveHinged, solveLifted } = require('../src/lab/position');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual}, expected ${expected} ± ${tol}`);

/** What a reading with this Jacobian and reference would be at displacement d. */
const reading = (jacobian, reference, d, error = 0) => ({
  jacobian, reference, measured: reference + jacobian.reduce((s, j, a) => s + j * d[a], 0) + error,
});

/*
 * A stack seen from a corner, twice. The front pair sees up/down (y) and
 * in/out (z); the side pair sees up/down and sideways (x). From higher up,
 * each sees less of y and more of the horizontal direction.
 */
const LOW = { front: [0, 1.2, 0.4], side: [0.35, 1.0, 0] };
const HIGH = { front: [0, 0.7, 0.9], side: [0.8, 0.6, 0] };
const D = [0.8, -0.5, 1.5];

test('four readings from two views give back the displacement that made them', () => {
  const r = solvePosition([
    reading(LOW.front, 2.4, D), reading(LOW.side, 2.1, D),
    reading(HIGH.front, 1.4, D), reading(HIGH.side, 1.2, D),
  ]);
  assert.equal(r.determined, true);
  D.forEach((v, a) => near(r.d[a], v, 1e-9, `axis ${a}`));
  near(r.residualRms, 0, 1e-9, 'residual');
  assert.equal(r.observations, 4);
});

test('one view of two pairs does not determine three axes, and says so', () => {
  const r = solvePosition([reading(LOW.front, 2.4, D), reading(LOW.side, 2.1, D)]);
  assert.equal(r.determined, false);
  assert.equal(r.d, null);
  assert.match(r.reason, /2 readings for 3 unknowns/);
});

test('three readings that are the same mixture do not either', () => {
  // The same pair from the same view, three times: three numbers, one equation.
  const r = solvePosition([reading(LOW.front, 2.4, D), reading(LOW.front, 2.4, D), reading(LOW.side, 2.1, D)]);
  assert.equal(r.determined, false);
  assert.match(r.reason, /do not separate/);
});

test('an axis nothing responds to is named', () => {
  const r = solvePosition([
    reading([0, 1.2, 0.4], 2, D), reading([0, 0.7, 0.9], 1, D), reading([0, 1.0, 0.1], 1, D),
  ]);
  assert.equal(r.determined, false);
  assert.match(r.reason, /axis 0/);
});

test('sigma is the millimetres each axis gets per pixel of reading error', () => {
  // Three readings, one per axis, at 2, 1 and 0.5 px per mm: a pixel of error
  // is half a millimetre, one, and two.
  const obs = [reading([2, 0, 0], 0, D), reading([0, 1, 0], 0, D), reading([0, 0, 0.5], 0, D)];
  const r = solvePosition(obs);
  near(r.sigma[0], 0.5, 1e-12, 'x'); near(r.sigma[1], 1, 1e-12, 'y'); near(r.sigma[2], 2, 1e-12, 'z');
  // And an error of one pixel in the third reading moves z by exactly that.
  const off = solvePosition([obs[0], obs[1], reading([0, 0, 0.5], 0, D, 1)]);
  near(off.d[2] - D[2], 2, 1e-12, 'z error');
  near(off.d[0], D[0], 1e-12, 'x untouched');
});

test('sigma depends on the views and not on what was read', () => {
  const at = (d, e) => solvePosition([
    reading(LOW.front, 2.4, d, e), reading(LOW.side, 2.1, d, -e),
    reading(HIGH.front, 1.4, d, e), reading(HIGH.side, 1.2, d, 0),
  ]).sigma;
  assert.deepEqual(at([0, 0, 0], 0), at([3, -2, 1], 0.4));
});

test('a second view at nearly the same elevation separates the axes badly, and sigma shows it', () => {
  const NEARLY = { front: [0, 1.18, 0.43], side: [0.37, 0.99, 0] };
  const close = solvePosition([reading(LOW.front, 0, D), reading(LOW.side, 0, D),
    reading(NEARLY.front, 0, D), reading(NEARLY.side, 0, D)]);
  const apart = solvePosition([reading(LOW.front, 0, D), reading(LOW.side, 0, D),
    reading(HIGH.front, 0, D), reading(HIGH.side, 0, D)]);
  assert.equal(close.determined, true);
  assert.ok(close.sigma[2] > 10 * apart.sigma[2], `z: ${close.sigma[2]} against ${apart.sigma[2]}`);
});

test('more readings than unknowns are fitted, and the residual is what they disagree by', () => {
  const r = solvePosition([
    reading(LOW.front, 2.4, D, 0.1), reading(LOW.side, 2.1, D, -0.1),
    reading(HIGH.front, 1.4, D, 0.1), reading(HIGH.side, 1.2, D, -0.1),
  ]);
  assert.ok(r.residualRms > 0 && r.residualRms < 0.1, `residual ${r.residualRms}`);
  D.forEach((v, a) => assert.ok(Math.abs(r.d[a] - v) < 0.5, `axis ${a} off by ${r.d[a] - v}`));
});

test('a weight makes a reading count for more', () => {
  // Two readings of x that disagree: 1 and 3. Unweighted, 2.
  const two = (w) => solvePosition([
    { jacobian: [1], reference: 0, measured: 1, weight: w }, { jacobian: [1], reference: 0, measured: 3 },
  ]).d[0];
  near(two(1), 2, 1e-12, 'equal weights');
  near(two(3), 1.5, 1e-12, 'the first three times over');
});

test('readings that were never made are left out, not read as zero', () => {
  const r = solvePosition([
    reading(LOW.front, 2.4, D), reading(LOW.side, 2.1, D), reading(HIGH.front, 1.4, D),
    { jacobian: HIGH.side, reference: 1.2, measured: null },
    { jacobian: HIGH.side, reference: 1.2, measured: undefined },
  ]);
  assert.equal(r.observations, 3);
  D.forEach((v, a) => near(r.d[a], v, 1e-9, `axis ${a}`));
});

/* ---- carried from the previous frame ------------------------------------ */

const diag = (...v) => v.map((x, a) => v.map((_, b) => (a === b ? x : 0)));

test('a prior and a reading of one axis meet where their variances say', () => {
  // A reading of x with variance 1/4 (weight 4) says 3; the prior, variance 1, says 1.
  const r = solvePosition([{ jacobian: [1], reference: 0, measured: 3, weight: 4 }],
    { prior: { d: [1], covariance: [[1]] } });
  near(r.d[0], (4 * 3 + 1 * 1) / (4 + 1), 1e-12, 'mean');
  near(r.covariance[0][0], 1 / (4 + 1), 1e-12, 'variance');
});

test('one view of two pairs, never determined alone, is determined with the previous frame carried in', () => {
  const obs = [reading(LOW.front, 2.4, D), reading(LOW.side, 2.1, D)].map((o) => ({ ...o, weight: 100 }));
  assert.equal(solvePosition(obs).determined, false);
  const prior = { d: [D[0] + 0.3, D[1] - 0.2, D[2] + 0.4], covariance: diag(0.25, 0.25, 0.25) };
  const r = solvePosition(obs, { prior });
  assert.equal(r.determined, true);
  // The two directions the readings see are pulled to them; the one they do
  // not see stays where the prior put it, and keeps the prior's uncertainty.
  for (const [o, name] of [[obs[0], 'front'], [obs[1], 'side']]) {
    const read = o.jacobian.reduce((s, j, a) => s + j * r.d[a], o.reference);
    near(read, o.measured, 0.02, `${name} reading`);
  }
  const blind = [LOW.front[1] * LOW.side[2] - LOW.front[2] * LOW.side[1],
    LOW.front[2] * LOW.side[0] - LOW.front[0] * LOW.side[2],
    LOW.front[0] * LOW.side[1] - LOW.front[1] * LOW.side[0]];
  const len = Math.hypot(...blind);
  const along = (v) => v.reduce((s, x, a) => s + x * blind[a], 0) / len;
  near(along(r.d), along(prior.d), 1e-9, 'the unseen direction');
  r.sigma.forEach((s) => assert.ok(s < 0.5 + 1e-12, `sigma ${s} over the prior's`));
});

test('a vague prior changes nothing that the readings decide', () => {
  const obs = [reading(LOW.front, 2.4, D), reading(LOW.side, 2.1, D), reading(HIGH.front, 1.4, D), reading(HIGH.side, 1.2, D)];
  const r = solvePosition(obs, { prior: { d: [50, -50, 50], covariance: diag(1e12, 1e12, 1e12) } });
  D.forEach((v, a) => near(r.d[a], v, 1e-6, `axis ${a}`));
});

test('a prior with no readings is the prior, and a singular one is refused', () => {
  const r = solvePosition([], { prior: { d: [1, 2], covariance: diag(0.04, 0.09) } });
  assert.deepEqual(r.d.map((v) => +v.toFixed(12)), [1, 2]);
  near(r.sigma[1], 0.3, 1e-12, 'sigma');
  assert.match(solvePosition([], { prior: { d: [1, 2], covariance: diag(0.04, 0) } }).reason, /singular/);
});

test('no readings at all is an answer too', () => {
  const r = solvePosition([]);
  assert.equal(r.determined, false);
  assert.match(r.reason, /no readings/);
});

/*
 * Hinged readings: a second slope below zero on x and z. Made from the hinged
 * model on every combination of sides, the displacement must come back
 * exactly -- whichever side the first, unhinged solve lands on.
 */
const hinged = (jacobian, hinge, reference, d) => ({
  jacobian, hinge, reference,
  measured: reference + jacobian.reduce((s, j, a) => s + j * d[a] + hinge[a] * Math.min(d[a], 0), 0),
});
const HINGED = [
  [[0, 1.2, 0.4], [0, 0, 0.05]], [[0.35, 1.0, 0], [-0.06, 0, 0]],
  [[0, 0.7, 0.9], [0, 0, 0.08]], [[0.8, 0.6, 0], [-0.05, 0, 0]],
  [[0.5, 0.3, -0.6], [0.02, 0, -0.03]],
];

test('hinged readings give back the displacement on every side of zero', () => {
  for (const x of [-2.5, -0.01, 0.01, 2]) {
    for (const z of [-1.5, 0.3]) {
      const d = [x, 0.7, z];
      const r = solveHinged(HINGED.map(([j, h], k) => hinged(j, h, 4 + k, d)));
      assert.ok(r.determined, r.reason);
      r.d.forEach((v, a) => near(v, d[a], 1e-9, `axis ${a} at x ${x}, z ${z}`));
    }
  }
});

test('with no hinges, solveHinged is solvePosition', () => {
  const obs = HINGED.map(([j], k) => reading(j, k, D));
  assert.deepEqual(solveHinged(obs), solvePosition(obs));
  assert.deepEqual(solveHinged(obs.map((o) => ({ ...o, hinge: [0, 0, 0] }))).d, solvePosition(obs).d);
});

/*
 * Lifted readings: each slope in x and z changes with the lift, y. Made from
 * that bilinear model, with hinges as well, the displacement comes back
 * exactly, from a start that knows nothing of the lift terms.
 */
const lifted = (jacobian, hinge, lift, reference, d) => ({
  jacobian, hinge, lift, reference,
  measured: reference + jacobian.reduce((s, j, a) => s + j * d[a] + hinge[a] * Math.min(d[a], 0) + lift[a] * d[1] * d[a], 0),
});
const LIFTS = [[0, 0, 0.02], [-0.03, 0, 0], [0, 0, 0.04], [0.05, 0, 0], [0.01, 0, -0.02]];

test('lifted readings give back the displacement, high and low, either side of zero', () => {
  for (const y of [-3, -0.5, 2]) {
    for (const x of [-2, 1.5]) {
      const d = [x, y, -0.8];
      const r = solveLifted(HINGED.map(([j, h], k) => lifted(j, h, LIFTS[k], 4 + k, d)));
      assert.ok(r.determined, r.reason);
      r.d.forEach((v, a) => near(v, d[a], 1e-8, `axis ${a} at x ${x}, y ${y}`));
      near(r.residualRms, 0, 1e-9, 'residual against the bilinear model');
    }
  }
});

test('a hinge that changes with the lift is solved too, on both sides of flush', () => {
  const LH = [[0, 0, 0.03], [-0.04, 0, 0], [0, 0, 0.02], [-0.03, 0, 0], [0.02, 0, -0.01]];
  for (const [x, z] of [[-2, -1], [1.5, -0.6], [-0.4, 1.2]]) {
    const d = [x, -2.5, z];
    const obs = HINGED.map(([j, h], k) => {
      const o = lifted(j, h, LIFTS[k], 4 + k, d);
      o.liftHinge = LH[k];
      o.measured += LH[k].reduce((acc, l, a) => acc + l * d[1] * Math.min(d[a], 0), 0);
      return o;
    });
    const r = solveLifted(obs);
    assert.ok(r.determined, r.reason);
    r.d.forEach((v, a) => near(v, d[a], 1e-8, `axis ${a} at x ${x}, z ${z}`));
  }
});

test('the lift terms matter: ignored, the same readings solve somewhere else', () => {
  const d = [1.5, -3, -0.8];
  const obs = HINGED.map(([j, h], k) => lifted(j, h, LIFTS[k], 4 + k, d));
  const wrong = solveHinged(obs);
  assert.ok(Math.max(...wrong.d.map((v, a) => Math.abs(v - d[a]))) > 0.05, 'ignoring the lift should cost something');
});

test('with no lift terms, solveLifted is solveHinged', () => {
  const obs = HINGED.map(([j, h], k) => hinged(j, h, 4 + k, [0.3, -1, -0.7]));
  assert.deepEqual(solveLifted(obs), solveHinged(obs));
  assert.deepEqual(solveLifted(obs.map((o) => ({ ...o, lift: [0, 0, 0] }))).d, solveHinged(obs).d);
});

if (failures > 0) {
  console.error(`\n${failures} position test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll position tests passed.');
