'use strict';

/**
 * A robot cell's calibration (packages/vision/src/cell.js): sweeps' frames to
 * a calibration, a frame to a pose, and the carry's pooled candidates, on
 * rows made from a model whose answer is known. What gap-sweep and
 * solve-position do with real renders through the same functions was held to
 * their output before the move, byte for byte, when they moved here; this is
 * the library's own contract, without files.
 *
 *   node test/cell.js
 */

const assert = require('node:assert/strict');

const {
  calibrateCell, solveCell, sweepFrames, sweepStep, posesFrom, numberByView, poolCandidates, carriable, fittedEdges,
  carriedPick, refitPick, pickSigma, medianGapSigma, AXES,
} = require('../packages/vision/src/cell.js');
const { calibrateReadings, POINTS, hingeFor } = require('../packages/vision/src/calibrate.js');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} against ${b}`);

/*
 * Three views, two pairs each: every reading -- the middle and a sixth in from
 * each end -- a known linear model of the displacement (x, y, z mm, turn deg),
 * with a one-sided slope in x below zero, as a ledge in sight gives. Distinct
 * enough to separate the four unknowns from every view together.
 */
const UNKNOWNS = ['x', 'y', 'z', 'turn'];
const MODELS = [];
for (const [yaw, elevation] of [[35, 20], [60, 20], [35, 50]]) {
  for (const pair of [1, 2]) {
    const k = MODELS.length + 1;
    const model = (j) => ({
      reference: 3 + k * 0.4 + j * 0.05,
      jacobian: [0.3 * Math.cos(k + j), 0.5 + 0.1 * k, 0.2 * Math.sin(2 * k + j), 0.04 * (j - 1) * k],
      hinge: [0.07 * k, 0, 0, 0],
    });
    MODELS.push({ yaw, elevation, pair, pairAngle: pair === 1 ? 3 + yaw / 10 : 91 + yaw / 10, points: [model(0), model(1), model(2)] });
  }
}
const at = (m, d) => m.reference + m.jacobian.reduce((s, j, a) => s + j * d[a], 0) + m.hinge[0] * Math.min(d[0], 0);

/** One frame's rows at displacement d: every view and pair, read by a track whose sigma is known. */
function frameRows(d, extra = {}) {
  return MODELS.map((m) => {
    const [mid, e1, e2] = m.points.map((p) => at(p, d));
    return {
      yaw: m.yaw, elevation: m.elevation, pair: m.pair, pairAngle: m.pairAngle, ...extra,
      trueGapPx: null, endsTruePx: null, measuredGapPx: mid + 0.3, endsDetectedPx: [e1 + 0.3, e2 + 0.3],
      refit: { from: 'pair', pair: m.pair, gapPx: mid + 0.1, endsPx: [e1 + 0.1, e2 + 0.1], gapSigma: 0.02 },
      tracked: { gapPx: mid, endsPx: [e1, e2], gapSigma: 0.01 + 0.001 * m.pair },
    };
  });
}

/** cv-lab's sweeps: x, y, z stepped along their axes, the turn by pose, all from the same reference. */
function sweeps() {
  const steps = [-4, -2, -1, 0, 1, 2, 4];
  const axisSweep = (a) => ({ axis: [0, 1, 2].map((k) => (k === a ? 1 : 0)),
    rows: steps.flatMap((s) => frameRows([0, 1, 2, 3].map((k) => (k === a ? s : 0)), { gapMm: s })) });
  return {
    x: axisSweep(0), y: axisSweep(1), z: axisSweep(2),
    turn: { rows: [-3, -1.5, 0, 1.5, 3].flatMap((t, k) => frameRows([0, 0, 0, t], { gapMm: 0, pose: k + 1, turnDeg: t })) },
  };
}

test('a cell calibrates from its own sweeps and solves a pose it was not calibrated on', () => {
  for (const mode of ['hinged', 'joint']) {
    const cal = calibrateCell({ sweeps: sweeps(), mode });
    assert.deepEqual(cal.unknowns, UNKNOWNS);
    assert.equal(cal.calibrated.length, MODELS.length * 3);
    // Joint has no one-sided slope, so it cannot be exact where the model has one: it only has to fit.
    if (mode !== 'hinged') continue;
    for (const [k, m] of MODELS.entries()) {
      for (const [j, point] of ['mid', 'end 1', 'end 2'].entries()) {
        const c = cal.calibrated.find((p) => p.key === `yaw ${m.yaw}, elev ${m.elevation} / pair ${m.pair} / ${point}`);
        assert.ok(c, `reading ${k} ${point}`);
        close(c.reference, m.points[j].reference, 1e-9, 'reference');
        m.points[j].jacobian.forEach((v, a) => close(c.jacobian[a], v, 1e-9, `slope ${a}`));
        close(c.hinge[0], m.points[j].hinge[0], 1e-9, 'hinge');
      }
    }
    // Off every sweep's axis, turned, slid back in x where the hinge bends the readings.
    const pose = [-1.3, 2.2, 0.7, 1.1];
    const s = solveCell(cal, frameRows(pose, { pose: 9 }));
    assert.equal(s.refused, null);
    assert.equal(s.readings, MODELS.length * 3);
    pose.forEach((v, a) => close(s.d[a], v, 1e-9, `pose ${UNKNOWNS[a]}`));
  }
});

test('calibrateCell is calibrateReadings over the carried readings, every key the frames hold', () => {
  const sw = sweeps();
  const cal = calibrateCell({ sweeps: sw, mode: 'hinged' });
  const direct = calibrateReadings({ sweepFrames: sweepFrames(sw, UNKNOWNS), unknowns: UNKNOWNS, mode: 'hinged',
    pick: carriedPick, points: POINTS.both, hingeOf: hingeFor(false), liftAxis: 1 });
  assert.deepEqual(cal.calibrated.map((p) => p.key), [...direct.keys()]);
  for (const p of cal.calibrated) {
    const q = direct.get(p.key);
    assert.deepEqual([p.reference, p.jacobian, p.hinge], [q.reference, q.jacobian, q.hinge]);
  }
  // The median gapSigma of the tracks and refits together: 0.011, 0.012 and 0.02.
  assert.equal(cal.medianSigma, medianGapSigma(Object.values(sw).flatMap((s) => s.rows)));
  assert.equal(cal.medianSigma, 0.012);
});

test('a frame too poor to separate the unknowns is refused, not solved', () => {
  const cal = calibrateCell({ sweeps: sweeps() });
  // One view alone: two pairs cannot separate four unknowns as well as maxSigma asks.
  const one = frameRows([1, 3, -1, 0.5], { pose: 1 }).filter((r) => r.yaw === 35 && r.elevation === 20);
  const s = solveCell(cal, one, { maxSigma: 0.5 });
  assert.notEqual(s.refused, null);
  assert.deepEqual(solveCell(cal, []), { d: null, sigma: null, residualRms: null, refused: 'undetermined', readings: 0 });
});

test('steps carry the sweep axis\'s sign; turns are their angle', () => {
  assert.equal(sweepStep('x', { gapMm: 2 }, [-1, 0, 0]), -2);
  assert.equal(sweepStep('y', { gapMm: 2 }, [0, 1, 0]), 2);
  assert.equal(sweepStep('z', { gapMm: 3 }, undefined), 3);
  assert.equal(sweepStep('turn', { gapMm: 0, turnDeg: -1.5 }, undefined), -1.5);
  assert.equal(sweepStep('tipz', { gapMm: 0, tipDeg: [0.2, 0.7] }, undefined), 0.7);
  const frames = sweepFrames({ x: { axis: [-1, 0, 0], rows: [{ gapMm: 2, pair: 1 }, { gapMm: 1, pair: null }] } }, ['x']);
  assert.deepEqual(frames.map((f) => [f.sweep, f.step]), [['x', -2]]);
  assert.deepEqual(AXES, ['x', 'y', 'z']);
});

test('frames group into poses, every view\'s readings keyed as the calibration keys them', () => {
  const rows = [...frameRows([1, 2, 3, 0], { pose: 1 }), ...frameRows([0, 1, 0, 2], { pose: 2 })];
  const poses = posesFrom(rows, (r) => [r.pose, 0, 0, 0], POINTS.mid);
  assert.equal(poses.length, 2);
  assert.deepEqual(poses.map((p) => p.d[0]), [1, 2]);
  assert.equal(poses[0].readings.size, MODELS.length);
  assert.ok(poses[0].readings.has('yaw 60, elev 20 / pair 2 / mid'));
});

test('the picks prefer the track, then the refit, then the detection, each with its own sigma', () => {
  const r = { truth: 1, detected: 2, refit: 3, sigma: 0.02, tracked: 4, trackedSigma: 0.01 };
  assert.equal(carriedPick(r), 4);
  assert.equal(pickSigma(carriedPick, r), 0.01);
  assert.equal(refitPick(r), 3);
  assert.equal(pickSigma(refitPick, r), 0.02);
  const untracked = { ...r, tracked: null };
  assert.equal(carriedPick(untracked), 3);
  assert.equal(pickSigma(carriedPick, untracked), 0.02);
  assert.equal(pickSigma((x) => x.truth, r), null);
  assert.equal(medianGapSigma([{ refit: null, tracked: null }]), null);
});

test('pairs are numbered a view at a time, rows kept in order', () => {
  const rows = [
    { yaw: 35, elevation: 20, pairAngle: 90 }, { yaw: 60, elevation: 20, pairAngle: 4 },
    { yaw: 35, elevation: 20, pairAngle: 2 }, { yaw: 60, elevation: 20, pairAngle: 178 }, { yaw: 35, elevation: 20, pairAngle: null },
  ];
  // 4 and 178 degrees are one pair: lines, so 180 apart is the same.
  assert.deepEqual(numberByView(rows).map((r) => r.pair), [2, 1, 1, 1, null]);
});

test('another run\'s frames pool as carry candidates only where carryPlan would carry from them', () => {
  const opts = { carryMin: 3, ledgeMax: 1.2 };
  const record = { id: 7, a: { segment: 11, x0: 0, y0: 0, x1: 10, y1: 0 }, b: { segment: 12, x0: 0, y0: 4, x1: 10, y1: 4 } };
  const row = (refit, extra = {}) => ({ yaw: 35, elevation: 20, pair: 1, pairAngle: 0, gapMm: 2, detectedPair: [12, 11], refit, ...extra });
  const wide = { from: 'pair', pair: 7, gapPx: 4 };
  assert.ok(carriable(row(wide), opts));
  assert.ok(!carriable(row({ ...wide, gapPx: 2.9 }), opts), 'too narrow');
  assert.ok(!carriable(row({ ...wide, from: 'segment' }), opts), 'found inside one segment');
  assert.ok(!carriable(row({ ...wide, ledge: { gain: 1.2 } }), opts), 'a ledge');
  assert.ok(!carriable(row(null), opts), 'no refit');
  // detectedPair is [moving, target]: segment 11 is the still edge.
  const edges = fittedEdges(row(wide), [record]);
  assert.equal(edges.still, record.a);
  assert.equal(edges.moving, record.b);
  assert.equal(fittedEdges(row({ ...wide, pair: 8 }), [record]), null);
  const rows = [row(wide), row({ ...wide, gapPx: 2 }), row(wide, { gapMm: 4 })];
  const frameOf = (r) => (r.gapMm === 4 ? null : { name: `gap-${r.gapMm}.png`, fitted: [record] });
  const pooled = poolCandidates(rows, frameOf, opts, 'results/other');
  assert.equal(pooled.length, 1);
  assert.deepEqual(pooled[0].s, { name: 'gap-2.png', gapMm: 2, run: 'results/other', view: { yaw: 35, elevation: 20 } });
  assert.equal(pooled[0].view, '35,20');
  assert.equal(pooled[0].still, record.a);
});

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll cell tests passed.');
