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
 * Plain node, no pixels: it reads the gap-sweep.json each run wrote. The
 * computing is the vision package's (packages/vision/src/ledge.js).
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
                    pair's ledge ends. Swept down (--axis 0,-1,0), the moving
                    part is the one below, and the ledge its own top face
  --fits <dir>      gap-sweep --carry --ledge-fit runs whose free ledge fits
                    give the shadow's width (repeatable). Sharp images only;
                    without any, every width is zero, as good under blur
  --min-gain <x>    a free fit counts where it fits the pixels this many times
                    better than the strip alone              (default 1.5)
  --min-lit <px>    and where its shadow is this far from the still edge, so
                    there is lit ledge to see it against     (default 1.5)
  --out <file>      where the table goes; gap-sweep --ledge reads it
`.trim();

const { flushLines, ledgeTable, liftOf, movingBelow } = require('../packages/vision/src/ledge.js');

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

module.exports = { flushLines, ledgeTable, liftOf, movingBelow };
if (require.main === module) main();
