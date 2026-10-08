'use strict';

/**
 * The vision package's calibration and pose solve (packages/vision/src/
 * calibrate.js), on readings made from a model whose answer is known: a
 * calibration recovers the model, a frame's readings recover the pose. What
 * solve-position and servo do with real renders is held to its earlier output
 * byte for byte by notes/brads-notes/2026-10-08-package/regress.sh; this is
 * the library's own contract, without files.
 *
 *   node test/calibrate.js
 */

const assert = require('node:assert/strict');

const {
  calibrateReadings, solvePose, estimatePose, frameReadings, pairAngles, pairOf, carryForward, modelAt, hingeFor, keysOf,
} = require('../packages/vision/src/calibrate.js');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const UNKNOWNS = ['x', 'y', 'z', 'turn'];
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} against ${b}`);

/*
 * Three views, two pairs each, read at the middle: twelve readings whose gap
 * is a known linear model of the displacement, with a one-sided slope in x
 * where a ledge would be in sight. Distinct enough to separate four unknowns.
 */
const MODELS = [];
for (const [yaw, elevation] of [[35, 20], [60, 20], [35, 50]]) {
  for (const pair of [1, 2]) {
    const k = MODELS.length + 1;
    MODELS.push({
      view: { yaw, elevation }, pair,
      reference: 3 + k * 0.4,
      jacobian: [Math.cos(k) * 0.9, 1.1 - k * 0.07, Math.sin(k * 1.7) * 0.8, ((k % 3) - 1) * 0.3],
      hinge: [k % 2 ? 0.25 : -0.15, 0, 0, 0],
    });
  }
}
const truthOf = (m, d) => modelAt(m, d, { hingeOf: hingeFor(false) });
/** One gap-sweep row per model at displacement d, its value the model's plus `noise(k)`. */
const rowsAt = (d, noise = () => 0) => MODELS.map((m, k) => ({
  yaw: m.view.yaw, elevation: m.view.elevation, pair: m.pair, pairAngle: 20 + 50 * m.pair,
  trueGapPx: truthOf(m, d), tracked: { gapPx: truthOf(m, d) + noise(k), gapSigma: 0.02 },
}));
/** Sweeps along each unknown from the reference, as a cell would command them. */
const STEPS = { x: [-4, -2, -1, 0, 1, 2, 4], y: [-2, -1, 0, 1, 2, 4], z: [-4, -2, -1, 0, 1, 2, 4], turn: [-3, -1.5, 0, 1.5, 3] };
const sweepFrames = (noise) => UNKNOWNS.flatMap((u, a) => STEPS[u].flatMap((step) =>
  rowsAt(UNKNOWNS.map((_, b) => (a === b ? step : 0)), noise).map((row) => ({ sweep: u, step, row }))));
const pick = (r) => r.tracked;

console.log('cv-lab-2 calibration tests');

test('a hinged calibration recovers each reading\'s model, the one-sided slope included', () => {
  const calibrated = calibrateReadings({ sweepFrames: sweepFrames(), unknowns: UNKNOWNS, mode: 'hinged', pick, points: ['mid'] });
  assert.equal(calibrated.size, MODELS.length);
  for (const [k, m] of MODELS.entries()) {
    const c = calibrated.get(`yaw ${m.view.yaw}, elev ${m.view.elevation} / pair ${m.pair} / mid`);
    close(c.reference, m.reference, 1e-9, `reference ${k}`);
    m.jacobian.forEach((j, a) => close(c.jacobian[a], j, 1e-9, `slope ${k}/${a}`));
    close(c.hinge[0], m.hinge[0], 1e-9, `hinge ${k}`);
    assert.equal(c.calibration.kept, c.calibration.frames, 'nothing to drop from exact readings');
  }
});

test('joint without the hinge cannot describe a one-sided slope, and says so in its fit RMS', () => {
  const joint = calibrateReadings({ sweepFrames: sweepFrames(), unknowns: UNKNOWNS, mode: 'joint', pick, points: ['mid'] });
  const hinged = calibrateReadings({ sweepFrames: sweepFrames(), unknowns: UNKNOWNS, mode: 'hinged', pick, points: ['mid'] });
  const worst = (c) => Math.max(...[...c.values()].map((p) => p.calibration.rms));
  assert.ok(worst(joint) > 0.05 && worst(hinged) < 1e-9, `joint ${worst(joint)}, hinged ${worst(hinged)}`);
});

test('a frame that disagrees by far more than the rest is dropped from the fit', () => {
  const frames = sweepFrames();
  frames.find((f) => f.sweep === 'y' && f.step === 2 && f.row.pair === 1 && f.row.yaw === 35 && f.row.elevation === 20).row.tracked.gapPx += 3;
  const c = calibrateReadings({ sweepFrames: frames, unknowns: UNKNOWNS, mode: 'hinged', pick, points: ['mid'] })
    .get('yaw 35, elev 20 / pair 1 / mid');
  // The bad frame pulls the first fit, so a good one near it can go too; what
  // is left is exact, and gives the model back.
  assert.ok(c.calibration.kept < c.calibration.frames, `kept ${c.calibration.kept} of ${c.calibration.frames}`);
  MODELS[0].jacobian.forEach((j, a) => close(c.jacobian[a], j, 1e-9, `slope ${a}, the bad frame dropped`));
});

test('a frame\'s readings give its pose back, and a pose the readings cannot separate is refused', () => {
  const calibrated = [...calibrateReadings({ sweepFrames: sweepFrames(), unknowns: UNKNOWNS, mode: 'hinged', pick, points: ['mid'] }).values()];
  const d = [1.3, 2.2, -0.7, 0.9];
  const readings = new Map(rowsAt(d).map((r) => [`yaw ${r.yaw}, elev ${r.elevation} / pair ${r.pair} / mid`, { tracked: r.tracked.gapPx, trackedSigma: 0.02 }]));
  const { solution, refused } = solvePose(calibrated, readings, { pick: (r) => r.tracked, sigmaOf: (r) => r?.trackedSigma });
  assert.equal(refused, null);
  d.forEach((v, a) => close(solution.d[a], v, 1e-9, `unknown ${a}`));
  // One view alone: two readings, four unknowns.
  const one = calibrated.filter((p) => p.view === 'yaw 35, elev 20');
  assert.equal(solvePose(one, readings, { pick: (r) => r.tracked }).refused, 'undetermined');
});

test('a closed loop\'s frame: the pose from readings and a carried prior, and the right one of two hypotheses', () => {
  const calibrated = calibrateReadings({ sweepFrames: sweepFrames(), unknowns: UNKNOWNS, mode: 'hinged', pick, points: ['mid'] });
  const calibration = { calibrated: [...calibrated.values()], medianSigma: 0.02 };
  const truth = [0.4, 1.5, -0.3, 0.6];
  const rows = rowsAt(truth);
  const angles = pairAngles(rowsAt([0, 0, 0, 0]));
  assert.equal(pairOf({ ...rows[0], pairAngle: rows[0].pairAngle + 4 }, angles), 1, 'a pair is matched by its angle, within 10 degrees');
  const readings = frameReadings(rows, angles);
  // A track that could not tell its two readings apart: the right one and one 1.5 px off.
  const ambiguous = 'yaw 60, elev 20 / pair 2 / mid';
  const right = readings.get(ambiguous)[0];
  readings.set(ambiguous, [null, 0.02, [right + 1.5, right]]);
  const last = { d: [0.5, 2, -0.2, 0.5], covariance: UNKNOWNS.map((_, a) => UNKNOWNS.map((__, b) => (a === b ? 0.01 : 0))) };
  const prior = carryForward(last, [-0.1, -0.5, -0.1, 0.1], [0.01, 0.01, 0.01, 0.01]);
  close(prior.covariance[0][0], 0.02, 1e-15, 'the prior grows by the move\'s variance');
  const { solution, hypotheses } = estimatePose(calibration, readings, prior, { readingSigma: 0.05 });
  assert.deepEqual(hypotheses, { resolved: 1, unresolved: 0 });
  truth.forEach((v, a) => close(solution.d[a], v, 0.01, `unknown ${a}`));
});

test('without a truth to name them, the keys are the frames\' own', () => {
  const keys = keysOf(sweepFrames(), ['mid', 'end 1']);
  assert.equal(keys.length, MODELS.length * 2);
  assert.deepEqual(keys, [...keys].sort());
});

console.log(failures === 0 ? '\nAll calibration tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
