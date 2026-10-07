#!/usr/bin/env node
'use strict';

/**
 * A scene's ledge, measured from gap-sweep runs with no truth, for
 * `gap-sweep --ledge` to hold in every frame.
 *
 *   npm run ledge -- --flush results/stack-y/pairs --fits results/stack-x/pairs \
 *                    [--fits results/stack-z/pairs ...] --out results/stack-ledge.json
 *
 * Slid back, a part held above another uncovers a strip of the lower part's
 * top face inside the gap, lit up to the upper part's shadow; read as one
 * flat strip it puts the moving edge too far out, and by more the further it
 * slid (design-lab-model.md §5, "A fifteenth" and "A thirty-second"). Two
 * things place it in a frame, both per view and pair:
 *
 *   1. WHERE IT ENDS: where the still edge would be were the moving part flush,
 *      the gap a sweep straight up reads at that lift. From --flush, a
 *      `gap-sweep --carry` run along y with nothing slid: its tracked gap as a
 *      straight line in the commanded lift, px = a * lift + b.
 *   2. HOW SOFT THE SHADOW IS: the width a free ledge fit gives it (`gap-sweep
 *      --ledge-fit`) where the lit ledge is wide and the fit clearly better
 *      than the strip alone, per millimetre of lift -- a penumbra grows with the
 *      distance from what casts it. The median over --fits' frames; zero
 *      where none qualifies, or with no --fits. Measure it on SHARP images,
 *      or not at all: under a lens's blur zero does as well, and the free fit
 *      there overstates the width (design-lab-model.md §5, "A thirty-third").
 *
 * Plain node, no pixels: it reads the gap-sweep.json each run wrote.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const USAGE = `
CV-Lab ledge -- where a ledge ends and how soft its shadow is, per view and pair

  npm run ledge -- --flush <dir> --fits <dir> [--fits <dir> ...] --out <file>

  --flush <dir>     a gap-sweep --carry run's results directory (the one
                    holding gap-sweep.json), swept along y with nothing slid:
                    its tracked gap against the commanded lift is where each
                    pair's ledge ends
  --fits <dir>      gap-sweep --carry --ledge-fit runs whose free ledge fits
                    give the shadow's width (repeatable). Sharp images only;
                    without any, every width is zero, as good under blur
  --min-gain <x>    a free fit counts where it fits the pixels this many times
                    better than the strip alone              (default 1.5)
  --min-lit <px>    and where its shadow is this far from the still edge, so
                    there is lit ledge to see it against     (default 1.5)
  --out <file>      where the table goes; gap-sweep --ledge reads it
`.trim();

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[(s.length - 1) >> 1] : null; };
const angleApart = (a, b) => Math.abs((((a - b + 90) % 180) + 180) % 180 - 90);

/** The moving part's lift above contact for a row of a run: its pose's, or the sweep's step. */
function liftOf(run, r) {
  if (r.poseMm) return r.poseMm[1];
  return (run.offsetMm?.[1] ?? 0) + (run.axis?.[1] ?? 0) * r.gapMm;
}

/**
 * Per view and pair, the tracked gap as a line in the lift, least squares.
 * The run must be a sweep along y with nothing slid: elsewhere the gap is not
 * the flush one.
 */
function flushLines(run) {
  const slid = (run.offsetMm ?? [0, 0, 0]).some((v, k) => k !== 1 && v !== 0)
    || (run.axis ?? [0, 1, 0]).some((v, k) => k !== 1 && v !== 0);
  if (run.rows.some((r) => r.poseMm) || slid) throw new Error('--flush needs a sweep along y with nothing slid (--axis 0,1,0, no x or z offset)');
  const by = new Map();
  for (const r of run.rows) {
    if (r.pair == null || !Number.isFinite(r.tracked?.gapPx)) continue;
    const k = `${r.yaw},${r.elevation},${r.pair}`;
    if (!by.has(k)) by.set(k, { yaw: r.yaw, elevation: r.elevation, pair: r.pair, points: [], angles: [] });
    const e = by.get(k);
    e.points.push([liftOf(run, r), r.tracked.gapPx]);
    if (r.pairAngle != null) e.angles.push(r.pairAngle);
  }
  const out = [];
  for (const e of by.values()) {
    const n = e.points.length;
    if (n < 3) continue;
    const mx = e.points.reduce((s, p) => s + p[0], 0) / n, my = e.points.reduce((s, p) => s + p[1], 0) / n;
    const sxx = e.points.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
    if (!(sxx > 0)) continue;
    const a = e.points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx;
    const b = my - a * mx;
    const rms = Math.sqrt(e.points.reduce((s, p) => s + (p[1] - a * p[0] - b) ** 2, 0) / n);
    out.push({ yaw: e.yaw, elevation: e.elevation, pair: e.pair, pairAngle: median(e.angles), flush: [a, b], flushRms: rms, flushOf: n });
  }
  return out;
}

/** Each qualifying free fit's shadow width per mm of lift, keyed to an entry by view and angle. */
function widths(entries, runs, minGain, minLit) {
  const found = entries.map(() => []);
  for (const run of runs) {
    for (const r of run.rows) {
      const f = r.ledgeFit;
      // A shadow within a pixel and a half of the still edge leaves too little
      // lit ledge to say how soft it is: on the x sweep two such fits came out
      // 6 and 14 times wider than the wide ones.
      if (!f || !(f.lit >= minLit) || !(f.gain >= minGain) || !Number.isFinite(f.width)) continue;
      const lift = liftOf(run, r);
      if (!(lift > 0)) continue;
      const k = entries.findIndex((e) => e.yaw === r.yaw && e.elevation === r.elevation
        && r.pairAngle != null && angleApart(e.pairAngle, r.pairAngle) <= 10);
      if (k >= 0) found[k].push(f.width / lift);
    }
  }
  return found;
}

function ledgeTable(flushRun, fitRuns, { minGain = 1.5, minLit = 1.5 } = {}) {
  const entries = flushLines(flushRun);
  const found = widths(entries, fitRuns, minGain, minLit);
  return entries.map((e, k) => ({ ...e, widthPerMm: found[k].length ? median(found[k]) : 0, widthsOf: found[k].length }));
}

function parseArgs(argv) {
  const opts = { flush: null, fits: [], out: null, minGain: 1.5, minLit: 1.5 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--flush': opts.flush = argv[++i]; break;
      case '--fits': opts.fits.push(argv[++i]); break;
      case '--out': opts.out = argv[++i]; break;
      case '--min-gain': opts.minGain = Number(argv[++i]); break;
      case '--min-lit': opts.minLit = Number(argv[++i]); break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown option ${argv[i]}`);
    }
  }
  return opts;
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(`${err.message}\n\n${USAGE}`); process.exit(2); }
  if (opts.help || !opts.flush || !opts.out) { console.log(USAGE); process.exit(opts.help ? 0 : 2); }
  const read = (dir) => {
    const file = path.resolve(ROOT, dir, 'gap-sweep.json');
    if (!fs.existsSync(file)) throw new Error(`no gap-sweep.json in ${dir}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const fitRuns = opts.fits.map(read);
  if (fitRuns.some((r) => !r.carry?.ledgeFit)) console.warn('a --fits run was not made with --ledge-fit: it has no ledge fits');
  const entries = ledgeTable(read(opts.flush), fitRuns, { minGain: opts.minGain, minLit: opts.minLit });
  const table = { flushFrom: opts.flush, fitsFrom: opts.fits, minGain: opts.minGain, minLit: opts.minLit, entries };
  fs.writeFileSync(path.resolve(ROOT, opts.out), `${JSON.stringify(table, null, 2)}\n`);
  for (const e of entries) {
    console.log(`${String(e.yaw).padStart(4)}/${String(e.elevation).padEnd(4)} pair ${e.pair}  ends ${e.flush[0].toFixed(3)} px/mm `
      + `${e.flush[1] >= 0 ? '+' : '-'} ${Math.abs(e.flush[1]).toFixed(3)} (rms ${e.flushRms.toFixed(3)}, ${e.flushOf} frames)  `
      + `shadow ${e.widthPerMm.toFixed(3)} px/mm (${e.widthsOf} fits)`);
  }
}

module.exports = { flushLines, ledgeTable, liftOf };
if (require.main === module) main();
