#!/usr/bin/env node
'use strict';

/**
 * Sweep the gap between two parts down to contact, and measure how well the
 * pipeline sees it at each step.
 *
 *   npm run gap-sweep -- --name gap-1
 *
 * Three stages, each an existing tool:
 *
 *   1. generate   one render per gap, with ground truth and AOV passes,
 *                 from a shot list this script writes   -> generated/<name>/
 *   2. lab        pipelines/explained.lab over them      -> results/<name>/
 *   3. analyse    one row per gap (src/lab/gapsweep.js)  -> results/<name>/gap-sweep.{csv,json}
 *
 * plus an overlay per step, because a table reports numbers whether or not
 * the pairing behind them is right, and an overlay is where a wrong one shows.
 *
 * ONE INPUT CHANGES. Only the moving part's position does, along --axis; the
 * camera is the scene's saved camera and the lighting is the scene's own, for
 * every step. Placements are absolute, so each step is an independent render
 * and nothing carries from one to the next -- it looks like an approach and is
 * not a trajectory.
 *
 * Plain node: the two Electron stages run as child processes, the way you
 * would run them by hand, so this script adds no Electron entry point.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveScene } = require('../src/generate/driver');
const { gapRow, pxPerMm } = require('../src/lab/gapsweep');

const ROOT = path.join(__dirname, '..');

const USAGE = `
CV-Lab gap sweep -- the gap between two parts, stepped down to contact

  npm run gap-sweep -- --name <run> [options]

  --name <run>       writes generated/<run>/ and results/<run>/   (required)
  --scene <name>     a saved scene                        (default saved:gap-1)
  --moving <name>    the part that moves                  (default Cube)
  --target <name>    the part it closes on                (default Table)
  --axis <x,y,z>     the direction that OPENS the gap     (default 0,1,0)
  --gaps <mm,...>    the steps, in millimetres            (default 50,20,10,5,2,1,0.5,0)
  --size <px>        render size                          (default 512)
  --samples <n>      path-tracing samples per image       (default 96)
  --skip-render      reuse generated/<run>/, re-run the lab and the analysis
  --dry-run          print the shots and stop

The moving part's position in the scene file is taken as CONTACT, gap zero:
scenes/gap-1.json places the Cube resting on the Table with its front face
flush with the table's front edge, so the two edges close onto each other.
`.trim();

function parseArgs(argv) {
  const opts = {
    name: null, scene: 'saved:gap-1', moving: 'Cube', target: 'Table', axis: [0, 1, 0],
    gaps: [50, 20, 10, 5, 2, 1, 0.5, 0], size: 512, samples: 96, skipRender: false, dryRun: false,
  };
  const list = (s, what) => {
    const v = String(s).split(',').map(Number);
    if (v.length === 0 || !v.every(Number.isFinite)) throw new Error(`${what} needs numbers, not ${s}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--name': opts.name = argv[++i]; break;
      case '--scene': opts.scene = argv[++i]; break;
      case '--moving': opts.moving = argv[++i]; break;
      case '--target': opts.target = argv[++i]; break;
      case '--axis': {
        const v = list(argv[++i], '--axis');
        const len = Math.hypot(...v);
        if (v.length !== 3 || !(len > 0)) throw new Error('--axis needs three numbers, not all zero');
        opts.axis = v.map((x) => x / len);
        break;
      }
      case '--gaps': {
        opts.gaps = list(argv[++i], '--gaps');
        if (opts.gaps.some((g) => g < 0)) throw new Error('--gaps cannot be negative: that is interpenetration');
        break;
      }
      case '--size': opts.size = list(argv[++i], '--size')[0]; break;
      case '--samples': opts.samples = list(argv[++i], '--samples')[0]; break;
      case '--skip-render': opts.skipRender = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  return opts;
}

/** "gap-0p5mm.png": a gap's name, sortable by eye and safe as a file name. */
const shotName = (mm) => `gap-${String(mm).replace('.', 'p')}mm.png`;

/** One shot per gap; only the moving part's position differs between them. */
function gapShots(opts) {
  const scene = resolveScene(opts.scene);
  if (!scene?.sceneData) throw new Error(`${opts.scene} is not a saved scene`);
  const data = scene.sceneData;
  const moving = data.objects.find((o) => o.key === opts.moving && o.included);
  if (!moving) throw new Error(`${opts.scene} does not include ${opts.moving}`);
  if (!data.objects.some((o) => o.key === opts.target && o.included)) {
    throw new Error(`${opts.scene} does not include ${opts.target}`);
  }
  if (!data.camera) throw new Error(`${opts.scene} has no saved camera to hold fixed`);
  const contact = moving.transform.position;
  return opts.gaps.map((mm) => ({
    name: shotName(mm),
    gapMm: mm,
    camera: data.camera.position,
    target: data.camera.target,
    intensity: 1,
    transforms: {
      [opts.moving]: { position: contact.map((c, k) => c + opts.axis[k] * (mm / 1000)) },
    },
  }));
}

/** Run an Electron CLI the way it would be run by hand, output passed through. */
function electron(script, args) {
  const bin = require('electron'); // under plain node, the path to the binary
  const r = spawnSync(bin, [path.join(ROOT, script), ...args], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${script} exited with ${r.status ?? r.signal}`);
}

/** The feature lists one image's run wrote, by slot. */
function slots(file) {
  const lists = JSON.parse(fs.readFileSync(file, 'utf8'));
  const by = Object.fromEntries(lists.map((l) => [l.slot, l.features]));
  for (const s of ['T', 'F', 'EF', 'MF']) {
    if (!by[s]) throw new Error(`${file} has no ${s} slot -- was it run with pipelines/explained.lab?`);
  }
  return { truth: by.T, segments: by.F, explained: by.EF, matches: by.MF };
}

const fmt = (v, d = 2) => (v === null || v === undefined ? '' : Number(v).toFixed(d));

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help || !opts.name) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 2);
  }

  const gen = path.join('generated', opts.name);
  const res = path.join('results', opts.name);
  const shots = gapShots(opts);

  if (opts.dryRun) {
    for (const s of shots) {
      console.log(`${s.name.padEnd(16)} ${opts.moving} at ${s.transforms[opts.moving].position.map((v) => v.toFixed(4)).join(', ')}`);
    }
    return;
  }

  const shotsFile = path.join(gen, 'shots.json');
  if (opts.skipRender) {
    // Reusing renders is only honest if they are the renders of these shots.
    const had = fs.existsSync(shotsFile) && fs.readFileSync(shotsFile, 'utf8');
    if (had !== JSON.stringify(shots, null, 2)) {
      throw new Error(`${shotsFile} is not these shots; render again without --skip-render`);
    }
  } else {
    fs.mkdirSync(path.join(ROOT, gen), { recursive: true });
    fs.writeFileSync(path.join(ROOT, shotsFile), JSON.stringify(shots, null, 2));
    electron('scripts/generate-cli.js', [
      '--out', gen, '--scene', opts.scene, '--shots', shotsFile,
      '--size', String(opts.size), '--samples', String(opts.samples), '--truth', '--aovs',
    ]);
  }

  const images = shots.map((s) => path.join(gen, s.name));
  electron('scripts/lab-cli.js', [
    '--script', 'pipelines/explained.lab', '--as', 'linear',
    '--truth', gen, '--aovs', gen, '--out', res, '--quiet', ...images,
  ]);

  const overlays = path.join(res, 'overlays');
  for (const image of images) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/overlay.js'), image, res, overlays],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) throw new Error(`overlay of ${image} failed`);
  }

  const parts = { moving: opts.moving, target: opts.target };
  const rows = shots.map((s) => gapRow(
    slots(path.join(ROOT, res, s.name.replace(/\.png$/, '.features.json'))), s, parts));
  const scale = pxPerMm(rows);
  for (const r of rows) r.errorMm = scale && r.errorPx !== null ? r.errorPx / scale : null;

  const record = {
    scene: opts.scene, ...parts, axis: opts.axis, size: opts.size, samples: opts.samples,
    camera: shots[0].camera, look: shots[0].target, pxPerMm: scale, rows,
  };
  fs.writeFileSync(path.join(ROOT, res, 'gap-sweep.json'), JSON.stringify(record, null, 2));

  const causes = [...new Set(rows.flatMap((r) => Object.keys(r.causes)))].sort();
  const head = ['gapMm', 'trueGapPx', 'measuredGapPx', 'errorPx', 'errorMm', 'pairFound', 'spansBoth',
    `${opts.moving}Found`, `${opts.target}Found`, ...causes.map((c) => `inGap_${c}`), 'reason'];
  const csv = [head.join(',')].concat(rows.map((r) => [
    r.gapMm, fmt(r.trueGapPx, 3), fmt(r.measuredGapPx, 3), fmt(r.errorPx, 3), fmt(r.errorMm, 3),
    r.pairFound, r.spansBoth, `${r.moving.found}/${r.moving.findable}`, `${r.target.found}/${r.target.findable}`,
    ...causes.map((c) => r.causes[c] ?? 0),
    r.reason ? `"${r.reason.replace(/"/g, "'")}"` : '',
  ].join(',')));
  fs.writeFileSync(path.join(ROOT, res, 'gap-sweep.csv'), `${csv.join('\n')}\n`);

  console.log(`\n${opts.scene}: ${opts.moving} closing on ${opts.target}, ${opts.size}px, `
    + `${opts.samples} samples, ${fmt(scale, 3)} px per mm of gap`);
  console.log(csv.join('\n'));
  console.log(`\n${res}/gap-sweep.csv, gap-sweep.json, overlays/`);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
