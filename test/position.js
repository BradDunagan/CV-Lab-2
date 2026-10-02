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
const { solvePosition } = require('../src/lab/position');

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

test('no readings at all is an answer too', () => {
  const r = solvePosition([]);
  assert.equal(r.determined, false);
  assert.match(r.reason, /no readings/);
});

if (failures > 0) {
  console.error(`\n${failures} position test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll position tests passed.');
