#!/usr/bin/env node
'use strict';

/**
 * One relative position from several gap readings, scored against the truth.
 *
 *   npm run position -- --x results/stack-x/pairs --y results/stack-y/pairs \
 *                       --z results/stack-z/pairs
 *
 * Takes three gap sweeps of one fixture, one along each axis, all made from
 * the same reference pose (the same --offset) and the same views. From them:
 *
 *   1. THE JACOBIAN. For every facing pair in every view, how many pixels its
 *      gap moves per millimetre along x, y and z: the slope of the TRUE gap
 *      down each sweep. Nothing detected goes into it.
 *   2. WHAT A SET OF VIEWS IS WORTH. For each view alone, each two together,
 *      and all of them: millimetres of error per axis, per pixel of error in
 *      the readings. Known before anything is detected.
 *   3. WHAT WAS ACTUALLY READ. Every shot of the three sweeps is a pose whose
 *      displacement is known. Each is solved from its readings and compared.
 *
 * Plain node, no pixels: it reads the gap-sweep.json each sweep wrote.
 */

const fs = require('node:fs');
const path = require('node:path');
const { pxPerMmSlope } = require('../src/lab/gapsweep');
const { solvePosition } = require('../src/lab/position');

const ROOT = path.join(__dirname, '..');
const AXES = ['x', 'y', 'z'];

const USAGE = `
CV-Lab relative position -- several gap readings solved for one displacement

  npm run position -- --x <dir> --y <dir> --z <dir> [options]

  --x, --y, --z <dir>   the results directory of a gap sweep along that axis
                        (the one holding gap-sweep.json). All three must share
                        a reference pose and their views
  --out <file>          also write everything as JSON
  --max-views <n>       the largest set of views to combine   (default 3)
  --max-sigma <mm>      a pose is not solved from readings that would turn one
                        pixel of error into more than this on any axis
                                                              (default 10)
`.trim();

function parseArgs(argv) {
  const opts = { dirs: {}, out: null, maxViews: 3, maxSigma: 10 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--x' || arg === '--y' || arg === '--z') opts.dirs[arg.slice(2)] = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--max-views') opts.maxViews = Number(argv[++i]);
    else if (arg === '--max-sigma') opts.maxSigma = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

const viewOf = (r) => (r.yaw === undefined ? 'the saved view' : `yaw ${r.yaw}, elev ${r.elevation}`);
const keyOf = (r) => `${viewOf(r)} / pair ${r.pair}`;

/** Every way of choosing `n` of `items`, in order. */
function choose(items, n) {
  if (n === 0) return [[]];
  if (items.length < n) return [];
  const [first, ...rest] = items;
  return [...choose(rest, n - 1).map((c) => [first, ...c]), ...choose(rest, n)];
}

const rms = (v) => (v.length ? Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length) : null);
const fmt = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(d));

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`); process.exit(2);
  }
  if (opts.help || AXES.some((a) => !opts.dirs[a])) { console.log(USAGE); process.exit(opts.help ? 0 : 2); }

  const sweeps = Object.fromEntries(AXES.map((a) => {
    const file = path.resolve(ROOT, opts.dirs[a], 'gap-sweep.json');
    if (!fs.existsSync(file)) throw new Error(`no gap-sweep.json in ${opts.dirs[a]}`);
    return [a, JSON.parse(fs.readFileSync(file, 'utf8'))];
  }));
  const offsets = AXES.map((a) => JSON.stringify(sweeps[a].offsetMm ?? null));
  if (new Set(offsets).size !== 1) {
    throw new Error(`the three sweeps were made from different reference poses: --offset ${offsets.join(', ')}`);
  }
  const rowsOf = (a) => sweeps[a].rows.filter((r) => r.pair !== null && r.pair !== undefined);

  /* ---- 1. the Jacobian, and each pair's gap at the reference ---------- */

  const keys = [...new Set(AXES.flatMap((a) => rowsOf(a).map(keyOf)))].sort();
  const pairs = new Map();
  for (const key of keys) {
    const jacobian = AXES.map((a) => pxPerMmSlope(rowsOf(a).filter((r) => keyOf(r) === key)));
    // The reference is the true gap at step 0, which all three sweeps render.
    const zeros = AXES.flatMap((a) => rowsOf(a).filter((r) => keyOf(r) === key && r.gapMm === 0))
      .map((r) => r.trueGapPx).filter(Number.isFinite);
    if (jacobian.some((j) => j === null) || zeros.length === 0) continue;
    pairs.set(key, { key, view: key.split(' / ')[0], jacobian, reference: zeros.reduce((s, v) => s + v, 0) / zeros.length });
  }
  if (pairs.size === 0) throw new Error('no pair has a truth gap in all three sweeps');

  console.log('Pixels of gap per millimetre of displacement, from the truth:\n');
  console.log(`  ${'pair'.padEnd(34)} ${AXES.map((a) => a.padStart(8)).join('')}   gap at the reference`);
  for (const p of pairs.values()) {
    console.log(`  ${p.key.padEnd(34)} ${p.jacobian.map((j) => fmt(j).padStart(8)).join('')}   ${fmt(p.reference)} px`);
  }

  /* ---- the poses: every shot of the three sweeps ---------------------- */

  const poses = [];
  for (const a of AXES) {
    for (const step of [...new Set(rowsOf(a).map((r) => r.gapMm))]) {
      const d = AXES.map((b) => (b === a ? step : 0));
      const readings = new Map();
      for (const r of rowsOf(a).filter((x) => x.gapMm === step)) {
        readings.set(keyOf(r), { truth: r.trueGapPx, detected: r.measuredGapPx, refit: r.refit?.gapPx ?? null });
      }
      poses.push({ axis: a, step, d, readings });
    }
  }

  /* ---- 2 and 3. each set of views ------------------------------------- */

  const views = [...new Set([...pairs.values()].map((p) => p.view))];
  const sets = [];
  for (let n = 1; n <= Math.min(opts.maxViews, views.length); n++) sets.push(...choose(views, n));

  const MODES = [
    ['truth', (r) => r.truth, 'the true gaps (is linear good enough?)'],
    ['detected', (r) => r.detected, 'the detections\' own gaps'],
    ['refit', (r) => r.refit ?? r.detected, 'refit where there is one, else detected'],
  ];
  const report = { pairs: [...pairs.values()], sets: [] };

  for (const set of sets) {
    const used = [...pairs.values()].filter((p) => set.includes(p.view));
    const design = solvePosition(used.map((p) => ({ jacobian: p.jacobian, reference: 0, measured: 0 })));
    console.log(`\n${set.join('  +  ')}   (${used.length} pairs)`);
    if (!design.determined) {
      console.log(`  not determined: ${design.reason}`);
      report.sets.push({ views: set, determined: false, reason: design.reason });
      continue;
    }
    console.log(`  mm of error per px of reading error:  ${AXES.map((a, k) => `${a} ${fmt(design.sigma[k], 2)}`).join('   ')}`);
    const entry = { views: set, determined: true, sigma: design.sigma, modes: {} };
    for (const [mode, pick, what] of MODES) {
      const errors = AXES.map(() => []);
      let solved = 0;
      const worst = { size: 0, text: '' };
      for (const pose of poses) {
        const obs = used.map((p) => ({ jacobian: p.jacobian, reference: p.reference,
          measured: pose.readings.has(p.key) ? pick(pose.readings.get(p.key)) : null }));
        const s = solvePosition(obs);
        /*
         * A pose is solved from the readings it HAS, and a pose that lost a
         * reading or two can be left with ones that barely separate the axes.
         * The solve still returns numbers: one such pose came back 1.3 m from
         * where the part was. Its sigma said so, and is what refuses it.
         */
        if (!s.determined || Math.max(...s.sigma) > opts.maxSigma) continue;
        solved++;
        const e = s.d.map((v, k) => v - pose.d[k]);
        e.forEach((v, k) => errors[k].push(v));
        const size = Math.hypot(...e);
        if (size > worst.size) { worst.size = size; worst.text = `${pose.axis} ${pose.step} mm, off by ${e.map((v) => fmt(v, 2)).join(', ')}`; }
      }
      entry.modes[mode] = { solved, of: poses.length, rms: errors.map(rms), worst: worst.text };
      console.log(`  ${mode.padEnd(9)} ${String(solved).padStart(2)}/${poses.length} poses solved   rms error mm:  `
        + `${AXES.map((a, k) => `${a} ${fmt(rms(errors[k]), 2)}`).join('   ')}`
        + (solved ? `   worst: ${worst.text}` : '') + (mode === 'truth' ? `   <- ${what}` : ''));
    }
    report.sets.push(entry);
  }

  if (opts.out) {
    fs.writeFileSync(path.resolve(ROOT, opts.out), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n${opts.out}`);
  }
}

try { main(); } catch (err) { console.error(err.message); process.exit(1); }
