#!/usr/bin/env node
'use strict';

/**
 * One relative position from several gap readings, scored against the truth.
 *
 *   npm run position -- --x results/stack-x/pairs --y results/stack-y/pairs \
 *                       --z results/stack-z/pairs [--turn results/stack-turn/pairs] \
 *                       [--test results/stack-poses/pairs]
 *
 * Takes a gap sweep along each axis of one fixture, all made from the same
 * reference pose (the same --offset) and the same views; optionally a sweep
 * of turns about the vertical (gap-sweep --poses, every pose at the reference
 * offset); and optionally a set of test poses (gap-sweep --poses). From them:
 *
 *   1. THE JACOBIAN. For every reading -- each facing pair in each view, at
 *      its middle and a sixth in from each end -- how many pixels it moves
 *      per millimetre along x, y and z, and per degree of turn: the slope of
 *      the TRUE reading down each sweep. Nothing detected goes into it.
 *   2. WHAT A SET OF VIEWS IS WORTH. For each view alone, each two together,
 *      and so on: millimetres (or degrees) of error per pixel of error in the
 *      readings. Known before anything is detected.
 *   3. WHAT WAS ACTUALLY READ. Every shot of the sweeps, and every test pose,
 *      is a pose whose displacement is known. Each is solved from its readings
 *      and compared. The test poses are the honest set: the Jacobian was not
 *      measured on them.
 *
 * Plain node, no pixels: it reads the gap-sweep.json each sweep wrote.
 */

const fs = require('node:fs');
const path = require('node:path');
const { solvePosition, solveLifted } = require('../packages/vision/src/position.js');
const { ANGLES, POINTS, viewOf, keyOf, readingsOf, hingeFor, calibrateReadings, solvePose } =
  require('../packages/vision/src/calibrate.js');
const { movingBelow } = require('../packages/vision/src/ledge.js');
const AXES = ['x', 'y', 'z'];

const ROOT = path.join(__dirname, '..');

const USAGE = `
CV-Lab relative position -- several gap readings solved for one displacement

  npm run position -- --x <dir> --y <dir> --z <dir> [options]

  --x, --y, --z <dir>   the results directory of a gap sweep along that axis, or
                        several renders of it, comma-separated, calibrated from
                        together
                        (the one holding gap-sweep.json). All three must share
                        a reference pose (--offset) and their views
  --turn <dir>          a gap-sweep --poses run of turns about the vertical,
                        every pose at the reference offset: adds the turn as a
                        fourth unknown, in degrees
  --tipx, --tipz <dir>  gap-sweep --poses runs of tips about the x or the z axis,
                        every pose at the reference offset: adds that tip as
                        an unknown, in degrees, as --turn adds the turn
  --test <dir>          a gap-sweep --poses run to score, poses the Jacobian
                        was not measured on
  --readings <which>    mid | ends | both: where along each pair the gap is
                        read. "ends" is a sixth in from each end; a turn is
                        only visible in those                 (default both)
  --weights <how>       sigma | none: whether each refit reading counts in
                        proportion to 1/gapSigma^2, the fit's own say of how
                        well its pixels pin the gap. Truth and detections are
                        never weighted                        (default sigma)
  --sequence <dir>      a gap sweep to solve as a sequence of frames, in the
                        order it was swept (repeatable): each frame alone, and
                        each with the previous frame's pose carried in -- its
                        solution moved by the motion commanded since, which a
                        robot knows, as a prior. Run with --carry, its tracked
                        readings are used too (the "carried" readings)
  --reading-sigma <px>  a reading's error, for weighing readings against the
                        carried pose; gapSigma sets readings' weights relative
                        to one another                       (default 0.1)
  --motion-sigma <mm>   how far a commanded move may miss, per frame and axis
                                                              (default 0.1)
  --turn-sigma <deg>    the same for the turn                 (default 0.1)
  --start-sigma <mm>    how well the first frame's pose is known before it is
                        seen: the commanded one, to this; degrees for a turn
                                                              (default 1)
  --trials <n>          the commanded poses and moves are the true ones with
                        errors of these sizes drawn at random (seeded); each
                        sequence is run this many times      (default 20)
  --out <file>          also write everything as JSON
  --save-calibration <file>
                        write the carried readings' calibration -- each
                        reading's reference and Jacobian, as --calibrate made
                        them -- for a closed loop to solve frames against
                        (npm run servo)
  --calibrate <from>    where each reading's reference and Jacobian come from:
                          truth      both from the renderer's truth
                          reference  the reference from what was READ, in the
                                     same mode, at the reference pose (every
                                     sweep's step 0, averaged); the Jacobian
                                     from the truth
                          full       both from what was read: the reference,
                                     and the slope of the readings along each
                                     sweep. No truth at all, as in a real cell
                          joint      the same, fitted as one: each reading's
                                     reference and every slope together, by
                                     least squares over every calibration
                                     frame of every sweep, with readings more
                                     than 3 MADs off dropped before a refit
                          hinged     joint, and a second slope in x and in z
                                     that applies only below zero: a ledge
                                     beside the moving edge appears on one
                                     side of flush only
                        A reading that cannot be calibrated is dropped (default truth)
  --lift <dir>          a gap sweep (an axis, or --poses) made at another lift:
                        its frames join a joint or hinged calibration, which
                        then fits each reading's slopes in x, z and the turn
                        as changing with the lift -- a y*x, y*z and y*turn
                        term -- and the solve is made with them. Repeatable
  --tip-prior <deg>     with --tipx/--tipz, what is known of a tip before it is
                        seen: zero, to this many degrees (a gripper holds a part
                        level to about so much). Readings weighed absolutely,
                        1/gapSigma^2 px^-2, against it            (default: none)
  --robust <px>         reweight each pose's readings by Huber's rule: a reading
                        whose residual exceeds this many px counts linearly,
                        not quadratically, for five rounds    (default: off)
  --max-views <n>       the largest set of views to combine   (default 3)
  --max-sigma <n>       a pose is not solved from readings that would turn one
                        pixel of error into more than this on any unknown
                                                              (default 10)
  --max-residual <px>   nor when its readings disagree with its solution by
                        more than this, RMS. Off by default: good solves run
                        0.02-0.06, but one ordinary test pose runs 0.51
                        and bad ones 0.47-0.60       (default: no limit)
`.trim();

function parseArgs(argv) {
  const opts = { dirs: {}, test: null, readings: 'both', weights: 'sigma', out: null, maxViews: 3, maxSigma: 10, maxResidual: Infinity,
    calibrate: 'truth', saveCalibration: null, sequences: [], lift: [], robust: 0, tipPrior: 0, readingSigma: 0.1, motionSigma: 0.1, turnSigma: 0.1, startSigma: 1, trials: 20 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--x', '--y', '--z', '--turn', '--tipx', '--tipz'].includes(arg)) opts.dirs[arg.slice(2)] = argv[++i];
    else if (arg === '--test') opts.test = argv[++i];
    else if (arg === '--calibrate') opts.calibrate = argv[++i];
    else if (arg === '--sequence') opts.sequences.push(argv[++i]);
    else if (arg === '--lift') opts.lift.push(argv[++i]);
    else if (arg === '--robust') opts.robust = Number(argv[++i]);
    else if (arg === '--tip-prior') opts.tipPrior = Number(argv[++i]);
    else if (arg === '--reading-sigma') opts.readingSigma = Number(argv[++i]);
    else if (arg === '--motion-sigma') opts.motionSigma = Number(argv[++i]);
    else if (arg === '--turn-sigma') opts.turnSigma = Number(argv[++i]);
    else if (arg === '--start-sigma') opts.startSigma = Number(argv[++i]);
    else if (arg === '--trials') opts.trials = Number(argv[++i]);
    else if (arg === '--readings') opts.readings = argv[++i];
    else if (arg === '--weights') opts.weights = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--save-calibration') opts.saveCalibration = argv[++i];
    else if (arg === '--max-views') opts.maxViews = Number(argv[++i]);
    else if (arg === '--max-sigma') opts.maxSigma = Number(argv[++i]);
    else if (arg === '--max-residual') opts.maxResidual = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!['mid', 'ends', 'both'].includes(opts.readings)) throw new Error('--readings is mid, ends or both');
  if (!['none', 'sigma'].includes(opts.weights)) throw new Error('--weights is none or sigma');
  if (!['truth', 'reference', 'full', 'joint', 'hinged'].includes(opts.calibrate)) throw new Error('--calibrate is truth, reference, full, joint or hinged');
  if (opts.lift.length > 0 && !['joint', 'hinged'].includes(opts.calibrate)) throw new Error('--lift needs --calibrate joint or hinged');
  return opts;
}

/** Every way of choosing `n` of `items`, in order. */
function choose(items, n) {
  if (n === 0) return [[]];
  if (items.length < n) return [];
  const [first, ...rest] = items;
  return [...choose(rest, n - 1).map((c) => [first, ...c]), ...choose(rest, n)];
}

const rms = (v) => (v.length ? Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length) : null);
const fmt = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(d));

function load(dir) {
  const file = path.resolve(ROOT, dir, 'gap-sweep.json');
  if (!fs.existsSync(file)) throw new Error(`no gap-sweep.json in ${dir}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`); process.exit(2);
  }
  if (opts.help || ['x', 'y', 'z'].some((a) => !opts.dirs[a])) { console.log(USAGE); process.exit(opts.help ? 0 : 2); }

  const unknowns = ['x', 'y', 'z', ...ANGLES.filter((u) => opts.dirs[u])];
  const units = (u) => (ANGLES.includes(u) ? 'deg' : 'mm');
  // A row's angles, for the angular unknowns this solve has.
  const angleOf = (u, r) => (u === 'turn' ? r.turnDeg ?? 0 : r.tipDeg?.[u === 'tipx' ? 0 : 1] ?? 0);
  const anglesOf = (r) => unknowns.filter((u) => ANGLES.includes(u)).map((u) => angleOf(u, r));
  /*
   * A sweep may be several runs of the same poses, comma-separated: their
   * frames are calibrated from together. One render's path-tracer noise is in
   * its calibration and so in every solve made with it (the thirty-first).
   */
  const loadAll = (dirs) => {
    const runs = String(dirs).split(',').map(load);
    return { ...runs[0], rows: runs.flatMap((r) => r.rows) };
  };
  const sweeps = Object.fromEntries(unknowns.map((u) => [u, loadAll(opts.dirs[u])]));
  const offsets = ['x', 'y', 'z'].map((a) => JSON.stringify(sweeps[a].offsetMm ?? null));
  if (new Set(offsets).size !== 1) {
    throw new Error(`the three sweeps were made from different reference poses: --offset ${offsets.join(', ')}`);
  }
  const reference = sweeps.x.offsetMm ?? [0, 0, 0];
  for (const u of ANGLES.filter((a) => opts.dirs[a])) {
    const off = (sweeps[u].poses ?? []).filter((p) => p.mm.some((v, k) => Math.abs(v - reference[k]) > 1e-9));
    if (off.length > 0) throw new Error(`every pose of the --${u} sweep must sit at the reference offset`);
  }

  /*
   * Each row of each sweep is a pose: its displacement from the reference,
   * and the step that the sweep moved along.
   */
  // A step along the sweep's own axis, which may run either way: a part below
  // the still one is swept down, and slid along -x and -z to mirror one above.
  const stepOf = (u, r) => (ANGLES.includes(u) ? angleOf(u, r) : r.gapMm * (sweeps[u].axis?.[AXES.indexOf(u)] ?? 1));
  /*
   * Which side a hinge is on: where the ledge is in sight. Slid back (x or z
   * below zero) with the moving part above; slid out the other way with it
   * below, when the ledge is its own top face (design-lab-model.md §5, "A
   * thirty-fifth").
   */
  const below = movingBelow(sweeps[unknowns.find((u) => !ANGLES.includes(u))]);
  const hingeOf = hingeFor(below);
  const displacementOf = (u, r) => unknowns.map((v) => (v === u ? stepOf(u, r) : 0));
  const rowsOf = (u) => sweeps[u].rows.filter((r) => r.pair !== null && r.pair !== undefined);
  /*
   * The --lift sweeps' frames: each row with its whole displacement from the
   * reference, an axis sweep's from its offset and step, a --poses run's from
   * its pose.
   */
  const LIFT = unknowns.indexOf('y');
  const liftRows = opts.lift.flatMap((dir) => {
    const sw = load(dir);
    return sw.rows.filter((r) => r.pair !== null && r.pair !== undefined).map((r) => {
      const mm = r.poseMm ?? [0, 1, 2].map((k) => (sw.offsetMm?.[k] ?? 0) + (sw.axis?.[k] ?? 0) * r.gapMm);
      return { row: r, d: [...mm.map((v, k) => v - reference[k]), ...anglesOf(r)] };
    });
  });
  const lifted = liftRows.length > 0;
  /*
   * A prior on the tips alone: zero, to --tip-prior degrees; every other
   * unknown free (a variance far past anything solved).
   */
  const tipPrior = opts.tipPrior > 0 && unknowns.some((u) => u === 'tipx' || u === 'tipz')
    ? { d: unknowns.map(() => 0),
      covariance: unknowns.map((u, a) => unknowns.map((v, b) => (a !== b ? 0
        : u === 'tipx' || u === 'tipz' ? opts.tipPrior ** 2 : 1e6))) }
    : null;
  // Against a prior the readings' weights must be absolute: --reading-sigma
  // px for a reading of the calibration sweeps' median gapSigma, as --sequence.
  const calSigmas = unknowns.flatMap((u) => rowsOf(u)).flatMap((r) => [r.tracked?.gapSigma, r.refit?.gapSigma])
    .filter((v) => v > 0).sort((a, b) => a - b);
  const calMedian = calSigmas.length ? calSigmas[(calSigmas.length - 1) >> 1] : 1;
  const points = POINTS[opts.readings];

  /* ---- 1. the Jacobian ---------------------------------------------- */

  // Every frame of every sweep, with the step it was made at.
  const sweepFrames = unknowns.flatMap((u) => rowsOf(u).map((row) => ({ sweep: u, step: stepOf(u, row), row })));
  const calibration = { sweepFrames, liftFrames: liftRows, unknowns, points, hingeOf, liftAxis: LIFT };
  // The truth's own slopes and intercepts: what every other mode is checked against.
  const readings = calibrateReadings({ ...calibration, liftFrames: [], mode: 'full', pick: (r) => r.truth });
  if (readings.size === 0) throw new Error('no reading has a truth value in every sweep');

  console.log(`Pixels per ${unknowns.map((u) => `${units(u)} of ${u}`).join(', ')}, from the truth:\n`);
  console.log(`  ${'reading'.padEnd(42)} ${unknowns.map((u) => u.padStart(8)).join('')}   at the reference`);
  for (const p of readings.values()) {
    console.log(`  ${p.key.padEnd(42)} ${p.jacobian.map((j) => fmt(j).padStart(8)).join('')}   ${fmt(p.reference)} px`);
  }

  /*
   * The same, per mode of reading, from what was READ instead of the truth.
   *
   * A reading's bias that holds still -- the side pair reading 0.1 px short
   * in every pose of a view -- moves every solve by the same amount when the
   * reference is the truth's. Taken from the readings themselves, with the
   * part at a pose that is known (a robot can put it there), the same bias is
   * in the reference and in the reading, and cancels. `full` goes on to the
   * Jacobian, which leaves no truth anywhere: what a real cell would have.
   */
  const calibrated = (pick) => (opts.calibrate === 'truth' ? readings
    : calibrateReadings({ ...calibration, mode: opts.calibrate, pick, base: readings }));
  const byPick = new Map();
  const calibratedFor = (pick) => { if (!byPick.has(pick)) byPick.set(pick, calibrated(pick)); return byPick.get(pick); };
  if (opts.calibrate !== 'truth') {
    console.log(`\nCalibrated from what was read (--calibrate ${opts.calibrate}): each mode of reading against its own.`);
  }

  /* ---- the poses ----------------------------------------------------- */

  const posesFrom = (rows, displacementFor) => {
    const groups = new Map();
    for (const r of rows) {
      const id = r.pose ?? `${r.gapMm}/${r.turnDeg ?? 0}/${r.tipDeg ?? ''}`;
      if (!groups.has(id)) groups.set(id, { d: displacementFor(r), label: null, readings: new Map() });
      for (const p of points) groups.get(id).readings.set(keyOf(r, p), readingsOf(r)[p]);
    }
    return [...groups.values()];
  };
  const sweepPoses = unknowns.flatMap((u) => posesFrom(rowsOf(u), (r) => displacementOf(u, r))
    .map((pose) => ({ ...pose, label: `${u} ${fmt(pose.d[unknowns.indexOf(u)], 1)}` })));
  const testPoses = opts.test
    ? posesFrom(load(opts.test).rows.filter((r) => r.pair !== null && r.pair !== undefined), (r) => [
      ...r.poseMm.map((v, k) => v - reference[k]),
      ...anglesOf(r),
    ]).map((pose, k) => ({ ...pose, label: `pose ${k + 1}` }))
    : [];

  /* ---- 2 and 3. each set of views ------------------------------------- */

  const views = [...new Set([...readings.values()].map((p) => p.view))];
  const sets = [];
  for (let n = 1; n <= Math.min(opts.maxViews, views.length); n++) sets.push(...choose(views, n));

  const refitPick = (r) => r.refit ?? r.detected;
  // A --carry run's tracked reading first: the still edge held where a frame
  // without a ledge read it (design-lab-model.md §5, the fifteenth).
  const carriedPick = (r) => r.tracked ?? r.refit ?? r.detected;
  const MODES = [
    ['truth', (r) => r.truth],
    ['detected', (r) => r.detected],
    ['refit', refitPick],
    ['carried', carriedPick],
  ];
  const sigmaOf = (pick, r) => (pick === carriedPick && r?.tracked != null ? r.trackedSigma
    : (pick === refitPick || pick === carriedPick) && r?.refit != null ? r.sigma : null);
  const report = { unknowns, reference, readings: [...readings.values()], sets: [],
    // What each reading was calibrated to, for the carried readings, beside the truth's.
    calibrated: opts.calibrate === 'truth' ? null : [...calibratedFor(carriedPick).values()] };
  /*
   * Whether the light is one this can be calibrated under, from the
   * calibration alone. A reading a straight model does not describe over its
   * own calibration frames is following something other than the gap: under
   * stack-4's high light, where a pair reads the top cube's shadow, the
   * worst readings' RMS about the fit was 0.34 to 0.57 px, against at most
   * 0.055 under stack-2's (design-lab-model.md §5, "A twenty-fourth").
   *
   * With the occluding track (the twenty-ninth) the shadow readings got
   * straighter and the worst under stack-4 is 0.115 -- the same as stack-2's
   * light with blur, noise and resampling all applied, 0.118. The MEDIAN
   * still separates them: 0.018 to 0.035 px under stack-2's light however
   * degraded, 0.068 under stack-4's. So either says so. Neither sees
   * stack-3's side light, which is straight (median 0.025) and solves ten
   * times worse: that takes test poses the robot commands (the thirtieth).
   */
  if (opts.calibrate === 'joint' || opts.calibrate === 'hinged') {
    const BAD_LIGHT_PX = 0.2, BAD_LIGHT_MEDIAN_PX = 0.05;
    const all = [...calibratedFor(carriedPick).values()].filter((p) => Number.isFinite(p.calibration?.rms));
    const bad = all.filter((p) => p.calibration.rms > BAD_LIGHT_PX);
    const sorted = all.map((p) => p.calibration.rms).sort((a, b) => a - b);
    const median = sorted.length ? sorted[(sorted.length - 1) >> 1] : null;
    if (bad.length > 0) {
      console.log(`\n  WARNING: ${bad.length} reading(s) are not straight in the pose over their own calibration frames`
        + ` (RMS over ${BAD_LIGHT_PX} px). The light is likely making a pair read a shadow; no calibration fixes that:`);
      for (const p of bad) console.log(`    ${p.key.padEnd(40)} ${fmt(p.calibration.rms)} px`);
    }
    if (median > BAD_LIGHT_MEDIAN_PX) {
      console.log(`\n  WARNING: the readings' median RMS about their own calibration is ${fmt(median)} px`
        + ` (over ${BAD_LIGHT_MEDIAN_PX}): under a light that suits them it is 0.02 to 0.035. Likely a shadow is being read.`);
    }
  }

  const score = (used, poses, pick) => {
    const errors = unknowns.map(() => []);
    const byPose = [];
    let solved = 0;
    const residuals = [];
    const worst = { size: 0, text: '' };
    for (const pose of poses) {
      /*
       * The refit's gapSigma is in the record at the middle only; the ends
       * are given the middle's (design-lab-model.md §5, "An eleventh").
       */
      const { solution: s, refused } = solvePose(used, pose.readings, {
        pick, sigmaOf: (r) => sigmaOf(pick, r), weights: opts.weights, maxSigma: opts.maxSigma, maxResidual: opts.maxResidual,
        prior: tipPrior, robust: opts.robust, medianSigma: calMedian, readingSigma: opts.readingSigma, liftAxis: LIFT, hingeOf,
      });
      if (refused === 'undetermined' || refused === 'geometry') continue;
      residuals.push(s.residualRms);
      if (refused === 'residual') continue;
      solved++;
      const e = s.d.map((v, k) => v - pose.d[k]);
      e.forEach((v, k) => errors[k].push(v));
      byPose.push({ pose: pose.label, error: e });
      const size = Math.hypot(...e);
      if (size > worst.size) { worst.size = size; worst.text = `${pose.label}, off by ${e.map((v) => fmt(v, 2)).join(', ')}`; }
    }
    return { solved, of: poses.length, rms: errors.map(rms), worst: worst.text, byPose, residuals };
  };
  const line = (mode, r) => `  ${mode.padEnd(9)} ${String(r.solved).padStart(2)}/${r.of} solved   rms:  `
    + unknowns.map((u, k) => `${u} ${fmt(r.rms[k], 2)}`).join('   ') + (r.solved ? `   worst: ${r.worst}` : '');

  for (const set of sets) {
    const used = [...readings.values()].filter((p) => set.includes(p.view));
    const design = solvePosition(used.map((p) => ({ jacobian: p.jacobian, reference: 0, measured: 0 })));
    console.log(`\n${set.join('  +  ')}   (${used.length} readings)`);
    if (!design.determined) {
      console.log(`  not determined: ${design.reason}`);
      report.sets.push({ views: set, determined: false, reason: design.reason });
      continue;
    }
    console.log(`  per px of reading error:  ${unknowns.map((u, k) => `${u} ${fmt(design.sigma[k], 2)} ${units(u)}`).join('   ')}`);
    const entry = { views: set, determined: true, sigma: design.sigma, sweeps: {}, test: {} };
    const usedBy = (pick) => [...calibratedFor(pick).values()].filter((p) => set.includes(p.view));
    for (const [mode, pick] of MODES) {
      entry.sweeps[mode] = score(usedBy(pick), sweepPoses, pick);
      console.log(line(mode, entry.sweeps[mode]) + (mode === 'truth' ? '   <- is linear good enough?' : ''));
    }
    if (testPoses.length > 0) {
      console.log('  test poses, which the Jacobian was not measured on:');
      for (const [mode, pick] of MODES) {
        entry.test[mode] = score(usedBy(pick), testPoses, pick);
        console.log(line(mode, entry.test[mode]));
      }
    }
    report.sets.push(entry);
  }

  /* ---- 4. sequences, each frame alone and with the last one carried --- */

  /*
   * A reading's value and its sigma in each mode. "carried" prefers the
   * tracked reading -- trackPair's, from a gap-sweep --carry run -- then the
   * refit, then the detection.
   */
  const SEQUENCE_MODES = [
    ['truth', (r) => [r.truth, null]],
    ['refit', (r) => (r.refit !== null ? [r.refit, r.sigma] : [r.detected, null])],
    ['carried', (r) => (r.tracked !== null ? [r.tracked, r.trackedSigma]
      : r.refit !== null ? [r.refit, r.sigma] : [r.detected, null])],
  ];
  const sequences = opts.sequences.map((dir) => {
    const run = load(dir);
    if (run.poses) throw new Error(`${dir} is a list of poses, not a sequence`);
    const offset = run.offsetMm ?? [0, 0, 0];
    const rows = run.rows.filter((r) => r.pair !== null && r.pair !== undefined);
    const frames = posesFrom(rows, (r) => [
      ...offset.map((o, k) => o + run.axis[k] * r.gapMm - reference[k]),
      ...anglesOf(r),
    ]).map((f, k) => ({ ...f, label: `frame ${k + 1}` }));
    return { dir, frames };
  });
  /*
   * Absolute weights, because a prior in millimetres is weighed against them:
   * a reading's variance is readingSigma squared, scaled by its gapSigma
   * against the median of all of them -- so the readings keep the weights
   * they have among themselves.
   */
  const allSigmas = sequences.flatMap((q) => q.frames.flatMap((f) => [...f.readings.values()]
    .flatMap((r) => [r.sigma, r.trackedSigma]))).filter((v) => v > 0).sort((a, b) => a - b);
  const medianSigma = allSigmas.length ? allSigmas[(allSigmas.length - 1) >> 1] : null;
  const weightOf = (sigma) => {
    const rel = opts.weights === 'sigma' && sigma > 0 && medianSigma ? sigma / medianSigma : 1;
    return 1 / (opts.readingSigma * rel) ** 2;
  };
  const motion = unknowns.map((u) => (ANGLES.includes(u) ? opts.turnSigma : opts.motionSigma) ** 2);
  const start = unknowns.map((u) => opts.startSigma ** 2);
  const diagonal = (v) => v.map((x, a) => v.map((_, b) => (a === b ? x : 0)));

  /*
   * What the robot believes, which is not the truth: the first pose it was
   * told to reach, off by startSigma, and each move after it, off by
   * motionSigma -- drawn from a seeded generator, so a run is repeatable. Fed
   * the TRUE poses instead, the carried solve inherits the truth in every
   * direction its readings cannot see, and a single view looks perfect. That
   * is how the first version of this measured it.
   */
  const gaussians = (seed) => {
    let x = seed >>> 0;
    const u = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x + 0.5) / 4294967296; };
    return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  };
  const commandedFor = (frames, trial) => {
    const g = gaussians(1000 + trial);
    const sd = (u, size) => (ANGLES.includes(u) ? (size === 'start' ? opts.startSigma : opts.turnSigma)
      : size === 'start' ? opts.startSigma : opts.motionSigma);
    const startErr = unknowns.map((u) => g() * sd(u, 'start'));
    const stepErr = frames.map(() => unknowns.map((u) => g() * sd(u, 'step')));
    return { startErr, stepErr };
  };

  const runSequence = (used, frames, pick, mode) => {
    const errors = unknowns.map(() => []);
    const byFrame = frames.map(() => []);
    let solved = 0;
    for (let trial = 0; trial < (mode === 'alone' ? 1 : opts.trials); trial++) {
      const { startErr, stepErr } = commandedFor(frames, trial);
      let state = null, believed = null;
      frames.forEach((frame, k) => {
        // Where dead reckoning puts the part: the commanded start, then each
        // commanded move, each with its own error.
        believed = k === 0 ? frame.d.map((v, a) => v + startErr[a])
          : believed.map((v, a) => v + frame.d[a] - frames[k - 1].d[a] + stepErr[k][a]);
        if (mode === 'commanded') {
          solved++;
          believed.forEach((v, a) => errors[a].push(v - frame.d[a]));
          byFrame[k].push(believed.map((v, a) => v - frame.d[a]));
          return;
        }
        const obs = used.map((p) => {
          const r = frame.readings.get(p.key);
          const [value, sigma] = r ? pick(r) : [null, null];
          return { jacobian: p.jacobian, hinge: p.hinge, lift: p.lift, liftHinge: p.liftHinge, reference: p.reference, measured: value, weight: weightOf(sigma) };
        });
        /*
         * Carried: the last solution moved by the commanded move, its
         * covariance grown by the move's; the first frame's prior is the
         * commanded pose. A frame that cannot be solved drops the chain back
         * to dead reckoning.
         */
        let prior = null;
        if (mode === 'carried') {
          prior = state
            ? { d: state.d.map((v, a) => v + frame.d[a] - frames[k - 1].d[a] + stepErr[k][a]),
              covariance: state.covariance.map((row, a) => row.map((x, b) => x + (a === b ? motion[a] : 0))) }
            : { d: believed.slice(), covariance: diagonal(k === 0 ? start : start.map((v, a) => v + k * motion[a])) };
        }
        const s = solveLifted(obs, { prior, liftAxis: LIFT });
        if (!s.determined || (mode === 'alone' && Math.max(...s.sigma) > opts.maxSigma * opts.readingSigma)) {
          state = null;
          return;
        }
        state = s;
        solved++;
        s.d.forEach((v, a) => errors[a].push(v - frame.d[a]));
        byFrame[k].push(s.d.map((v, a) => v - frame.d[a]));
      });
    }
    const runs = mode === 'alone' ? 1 : opts.trials;
    return { solved: solved / runs, of: frames.length, rms: errors.map(rms), byFrame };
  };
  /** RMS per unknown over the frames `keep` says, from runSequence's byFrame. */
  const rmsOver = (r, keep) => unknowns.map((_, a) => rms(r.byFrame.flatMap((list, k) => (keep(k) ? list.map((e) => e[a]) : []))));

  // The value alone of each sequence mode's reading, one function per mode,
  // so that its calibration is made once.
  const valueOnly = new Map(SEQUENCE_MODES.map(([mode, pick]) => [mode, (r) => pick(r)[0]]));
  report.sequences = [];
  for (const q of sequences) {
    console.log(`\nSEQUENCE ${q.dir}: ${q.frames.length} frames, each alone and with the last carried in`
      + ` (reading ${opts.readingSigma} px, motion ${opts.motionSigma} mm${opts.dirs.turn ? `, ${opts.turnSigma} deg` : ''}`
      + ` a frame, start ${opts.startSigma}; ${opts.trials} trials)`);
    const entry = { dir: q.dir, sets: [] };
    // The camera's contribution is what carrying does better than this.
    { const { byFrame, ...c } = runSequence([], q.frames, null, 'commanded'); entry.commanded = c; }
    console.log(`  commanded moves alone, no camera: ${unknowns.map((u, k) => `${u} ${fmt(entry.commanded.rms[k], 2)}`).join('  ')}`);
    for (const set of sets) {
      console.log(`  ${set.join('  +  ')}`);
      const result = { views: set };
      const cell = (r) => `${fmt(r.solved, 0).padStart(2)}/${r.of}  ${unknowns.map((u, k) => `${u} ${fmt(r.rms[k], 2)}`).join('  ')}`;
      for (const [mode, pick] of SEQUENCE_MODES) {
        const own = [...calibratedFor(valueOnly.get(mode)).values()].filter((p) => set.includes(p.view));
        const alone = runSequence(own, q.frames, pick, 'alone');
        const carried = runSequence(own, q.frames, pick, 'carried');
        // Like for like: the frames a frame alone could solve, and apart from
        // them the ones only carrying reached.
        const both = (k) => alone.byFrame[k].length > 0;
        const same = rmsOver(carried, both), extra = rmsOver(carried, (k) => !both(k));
        const strip = ({ byFrame, ...rest }) => rest;
        result[mode] = { alone: strip(alone), carried: { ...strip(carried), rmsSameFrames: same, rmsOtherFrames: extra } };
        const v = (x) => unknowns.map((u, k) => `${u} ${fmt(x[k], 2)}`).join('  ');
        console.log(`    ${mode.padEnd(8)} alone ${cell(alone)}   |   carried, same frames: ${v(same)}`
          + `${q.frames.length - alone.solved > 0 && carried.solved > alone.solved ? `   + ${fmt(carried.solved - alone.solved, 0)} more: ${v(extra)}` : ''}`);
      }
      entry.sets.push(result);
    }
    report.sequences.push(entry);
  }

  if (opts.saveCalibration) {
    /*
     * What a closed loop needs to solve a frame it has not seen: per reading,
     * the reference and Jacobian of the carried mode, and the median gapSigma
     * of the calibration frames, so that a frame's readings can be weighed
     * absolutely against a carried pose as --sequence does.
     */
    const sigmas = unknowns.flatMap((u) => rowsOf(u)).flatMap((r) => [r.tracked?.gapSigma, r.refit?.gapSigma])
      .filter((v) => v > 0).sort((a, b) => a - b);
    const saved = {
      unknowns, reference, calibrate: opts.calibrate, readings: opts.readings,
      // Which side of flush the hinge is on; estimatePose reads it.
      ...(below ? { movingBelow: true } : {}),
      sweeps: Object.fromEntries(unknowns.map((u) => [u, opts.dirs[u]])),
      medianSigma: sigmas.length ? sigmas[(sigmas.length - 1) >> 1] : null,
      ...(lifted ? { lift: opts.lift } : {}),
      calibrated: [...calibratedFor(carriedPick).values()].map(({ key, view, jacobian, hinge, lift, liftHinge, reference: at }) => ({
        key, view, jacobian, ...(hinge ? { hinge } : {}), ...(lift ? { lift } : {}), ...(liftHinge ? { liftHinge } : {}), reference: at })),
    };
    fs.writeFileSync(path.resolve(ROOT, opts.saveCalibration), `${JSON.stringify(saved, null, 2)}\n`);
    console.log(`\n${opts.saveCalibration}`);
  }

  if (opts.out) {
    fs.writeFileSync(path.resolve(ROOT, opts.out), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n${opts.out}`);
  }
}

try { main(); } catch (err) { console.error(err.message); process.exit(1); }
