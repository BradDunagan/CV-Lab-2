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
const { solvePosition } = require('../src/lab/position');

const ROOT = path.join(__dirname, '..');

const USAGE = `
CV-Lab relative position -- several gap readings solved for one displacement

  npm run position -- --x <dir> --y <dir> --z <dir> [options]

  --x, --y, --z <dir>   the results directory of a gap sweep along that axis
                        (the one holding gap-sweep.json). All three must share
                        a reference pose (--offset) and their views
  --turn <dir>          a gap-sweep --poses run of turns about the vertical,
                        every pose at the reference offset: adds the turn as a
                        fourth unknown, in degrees
  --test <dir>          a gap-sweep --poses run to score, poses the Jacobian
                        was not measured on
  --readings <which>    mid | ends | both: where along each pair the gap is
                        read. "ends" is a sixth in from each end; a turn is
                        only visible in those                 (default both)
  --weights <how>       sigma | none: whether each refit reading counts in
                        proportion to 1/gapSigma^2, the fit's own say of how
                        well its pixels pin the gap. Truth and detections are
                        never weighted                        (default sigma)
  --out <file>          also write everything as JSON
  --max-views <n>       the largest set of views to combine   (default 3)
  --max-sigma <n>       a pose is not solved from readings that would turn one
                        pixel of error into more than this on any unknown
                                                              (default 10)
`.trim();

function parseArgs(argv) {
  const opts = { dirs: {}, test: null, readings: 'both', weights: 'sigma', out: null, maxViews: 3, maxSigma: 10 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--x', '--y', '--z', '--turn'].includes(arg)) opts.dirs[arg.slice(2)] = argv[++i];
    else if (arg === '--test') opts.test = argv[++i];
    else if (arg === '--readings') opts.readings = argv[++i];
    else if (arg === '--weights') opts.weights = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--max-views') opts.maxViews = Number(argv[++i]);
    else if (arg === '--max-sigma') opts.maxSigma = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!['mid', 'ends', 'both'].includes(opts.readings)) throw new Error('--readings is mid, ends or both');
  if (!['none', 'sigma'].includes(opts.weights)) throw new Error('--weights is none or sigma');
  return opts;
}

const viewOf = (r) => (r.yaw === undefined ? 'the saved view' : `yaw ${r.yaw}, elev ${r.elevation}`);
const POINTS = { mid: ['mid'], ends: ['end 1', 'end 2'], both: ['mid', 'end 1', 'end 2'] };

/** Every way of choosing `n` of `items`, in order. */
function choose(items, n) {
  if (n === 0) return [[]];
  if (items.length < n) return [];
  const [first, ...rest] = items;
  return [...choose(rest, n - 1).map((c) => [first, ...c]), ...choose(rest, n)];
}

/** Least-squares slope and intercept of y against x. Null with under two points. */
function fitLine(points) {
  const p = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (p.length < 2) return null;
  const mx = p.reduce((s, [x]) => s + x, 0) / p.length;
  const my = p.reduce((s, [, y]) => s + y, 0) / p.length;
  let sxx = 0, sxy = 0;
  for (const [x, y] of p) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  return { slope, at0: my - slope * mx };
}

/** One row's readings at each point, as truth, detected and refit. */
function readingsOf(r) {
  const at = (k) => ({
    truth: r.endsTruePx?.[k] ?? null,
    detected: r.endsDetectedPx?.[k] ?? null,
    refit: r.refit?.endsPx?.[k] ?? null,
    sigma: r.refit?.gapSigma ?? null,
  });
  return {
    mid: { truth: r.trueGapPx, detected: r.measuredGapPx, refit: r.refit?.gapPx ?? null, sigma: r.refit?.gapSigma ?? null },
    'end 1': at(0),
    'end 2': at(1),
  };
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

  const unknowns = ['x', 'y', 'z', ...(opts.dirs.turn ? ['turn'] : [])];
  const units = (u) => (u === 'turn' ? 'deg' : 'mm');
  const sweeps = Object.fromEntries(unknowns.map((u) => [u, load(opts.dirs[u])]));
  const offsets = ['x', 'y', 'z'].map((a) => JSON.stringify(sweeps[a].offsetMm ?? null));
  if (new Set(offsets).size !== 1) {
    throw new Error(`the three sweeps were made from different reference poses: --offset ${offsets.join(', ')}`);
  }
  const reference = sweeps.x.offsetMm ?? [0, 0, 0];
  if (opts.dirs.turn) {
    const off = (sweeps.turn.poses ?? []).filter((p) => p.mm.some((v, k) => Math.abs(v - reference[k]) > 1e-9));
    if (off.length > 0) throw new Error('every pose of the --turn sweep must sit at the reference offset');
  }

  /*
   * Each row of each sweep is a pose: its displacement from the reference,
   * and the step that the sweep moved along.
   */
  const stepOf = (u, r) => (u === 'turn' ? r.turnDeg : r.gapMm);
  const displacementOf = (u, r) => unknowns.map((v) => (v === u ? stepOf(u, r) : 0));
  const rowsOf = (u) => sweeps[u].rows.filter((r) => r.pair !== null && r.pair !== undefined);
  const points = POINTS[opts.readings];

  /* ---- 1. the Jacobian ---------------------------------------------- */

  const keyOf = (r, point) => `${viewOf(r)} / pair ${r.pair} / ${point}`;
  const keys = new Set();
  for (const u of unknowns) for (const r of rowsOf(u)) for (const p of points) keys.add(keyOf(r, p));
  const readings = new Map();
  for (const key of [...keys].sort()) {
    const lines = unknowns.map((u) => fitLine(rowsOf(u)
      .flatMap((r) => points.filter((p) => keyOf(r, p) === key).map((p) => [stepOf(u, r), readingsOf(r)[p].truth]))));
    if (lines.some((l) => l === null)) continue;
    const at0 = lines.map((l) => l.at0);
    readings.set(key, {
      key, view: key.split(' / ')[0],
      jacobian: lines.map((l) => l.slope),
      reference: at0.reduce((s, v) => s + v, 0) / at0.length,
    });
  }
  if (readings.size === 0) throw new Error('no reading has a truth value in every sweep');

  console.log(`Pixels per ${unknowns.map((u) => `${units(u)} of ${u}`).join(', ')}, from the truth:\n`);
  console.log(`  ${'reading'.padEnd(42)} ${unknowns.map((u) => u.padStart(8)).join('')}   at the reference`);
  for (const p of readings.values()) {
    console.log(`  ${p.key.padEnd(42)} ${p.jacobian.map((j) => fmt(j).padStart(8)).join('')}   ${fmt(p.reference)} px`);
  }

  /* ---- the poses ----------------------------------------------------- */

  const posesFrom = (rows, displacementFor) => {
    const groups = new Map();
    for (const r of rows) {
      const id = r.pose ?? `${r.gapMm}/${r.turnDeg ?? 0}`;
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
      ...(opts.dirs.turn ? [r.turnDeg ?? 0] : []),
    ]).map((pose, k) => ({ ...pose, label: `pose ${k + 1}` }))
    : [];

  /* ---- 2 and 3. each set of views ------------------------------------- */

  const views = [...new Set([...readings.values()].map((p) => p.view))];
  const sets = [];
  for (let n = 1; n <= Math.min(opts.maxViews, views.length); n++) sets.push(...choose(views, n));

  const refitPick = (r) => r.refit ?? r.detected;
  const MODES = [
    ['truth', (r) => r.truth],
    ['detected', (r) => r.detected],
    ['refit', refitPick],
  ];
  const report = { unknowns, reference, readings: [...readings.values()], sets: [] };

  const score = (used, poses, pick) => {
    const errors = unknowns.map(() => []);
    let solved = 0;
    const worst = { size: 0, text: '' };
    for (const pose of poses) {
      /*
       * Weighted by the refit's gapSigma, which the record has at the middle
       * only; the ends are given the middle's. Not because sigma predicts the
       * error -- reading by reading it hardly does, a rank correlation of
       * 0.34 -- but it is lowest where a gap is wide and its edges long, and
       * among the readings of ONE pose that is enough. On the stack's test
       * poses it took the turn from 0.19 to 0.05 degrees RMS, averaged over
       * every set of views; with the end readings still tilted by a flat-
       * level fit it did nothing (design-lab-model.md §5, "An eleventh").
       */
      const obs = used.map((p) => {
        const r = pose.readings.get(p.key);
        return { jacobian: p.jacobian, reference: p.reference, measured: r ? pick(r) : null,
          weight: opts.weights === 'sigma' && pick === refitPick && r?.refit != null && r.sigma > 0 ? 1 / (r.sigma * r.sigma) : 1 };
      });
      const s = solvePosition(obs);
      /*
       * A pose is solved from the readings it HAS, and one that lost a few
       * can be left with readings that barely separate the unknowns. The
       * solve still returns numbers -- one pose came back 1.3 m from the part
       * -- and its sigma is what refuses it.
       */
      if (!s.determined || Math.max(...s.sigma) > opts.maxSigma) continue;
      solved++;
      const e = s.d.map((v, k) => v - pose.d[k]);
      e.forEach((v, k) => errors[k].push(v));
      const size = Math.hypot(...e);
      if (size > worst.size) { worst.size = size; worst.text = `${pose.label}, off by ${e.map((v) => fmt(v, 2)).join(', ')}`; }
    }
    return { solved, of: poses.length, rms: errors.map(rms), worst: worst.text };
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
    for (const [mode, pick] of MODES) {
      entry.sweeps[mode] = score(used, sweepPoses, pick);
      console.log(line(mode, entry.sweeps[mode]) + (mode === 'truth' ? '   <- is linear good enough?' : ''));
    }
    if (testPoses.length > 0) {
      console.log('  test poses, which the Jacobian was not measured on:');
      for (const [mode, pick] of MODES) {
        entry.test[mode] = score(used, testPoses, pick);
        console.log(line(mode, entry.test[mode]));
      }
    }
    report.sets.push(entry);
  }

  if (opts.out) {
    fs.writeFileSync(path.resolve(ROOT, opts.out), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n${opts.out}`);
  }
}

try { main(); } catch (err) { console.error(err.message); process.exit(1); }
