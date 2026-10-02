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
 *                 (or --script <file>: results/<name>/<script name>/)
 *   3. analyse    one row per gap (src/lab/gapsweep.js)  -> results/<name>/gap-sweep.{csv,json}
 *
 * plus an overlay per step, because a table reports numbers whether or not
 * the pairing behind them is right, and an overlay is where a wrong one shows.
 *
 * ONE INPUT CHANGES. Only the moving part's position does, along --axis; the
 * camera is the scene's saved camera and the lighting is the scene's own, for
 * every step.
 *
 * ...OR TWO. With --yaw and --elevation the sweep is repeated from each of a
 * grid of viewpoints, the saved camera orbited about its own target at its own
 * distance. That is where "poor depth along the viewing axis" shows: a camera
 * sees displacement across its line of sight and almost none along it, so the
 * same gap is fewer pixels from some views than from others, and the same
 * pixel error is more millimetres. The lights do not move with the camera. Placements are absolute, so each step is an independent render
 * and nothing carries from one to the next -- it looks like an approach and is
 * not a trajectory.
 *
 * Plain node: the two Electron stages run as child processes, the way you
 * would run them by hand, so this script adds no Electron entry point.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { resolveScene } = require('../src/generate/driver');
const { gapRows, pxPerMm, changedInputs, orbitViews } = require('../src/lab/gapsweep');

const ROOT = path.join(__dirname, '..');
const DEFAULT_SCRIPT = 'pipelines/explained.lab';

const USAGE = `
CV-Lab gap sweep -- the gap between two parts, stepped down to contact

  npm run gap-sweep -- --name <run> [options]

  --name <run>       writes generated/<run>/ and results/<run>/   (required)
  --scene <name>     a saved scene                        (default saved:gap-1)
  --moving <name>    the part that moves                  (default Cube)
  --target <name>    the part it closes on                (default Table)
  --axis <x,y,z>     the direction that OPENS the gap     (default 0,1,0)
  --gaps <mm,...>    the steps, in millimetres            (default 50,20,10,5,2,1,0.5,0)
  --yaw <deg,...>    viewpoints: yaw about the saved camera's target, 0 looking
                     along -z                             (default: the saved camera's)
  --elevation <deg,...>  and elevation above the horizontal  (default: the saved camera's)
                     Every yaw is taken with every elevation, at the saved
                     camera's distance. With neither, there is one view: the
                     saved camera, exactly
  --size <px>        render size                          (default 512)
  --samples <n>      path-tracing samples per image       (default 96)
  --tone-mapping <k> linear | aces                        (default linear)
  --exposure <x>     radiance multiplier before tone mapping (default 0.5)
  --script <file>    the pipeline to run         (default pipelines/explained.lab)
                     It must bind T, F, EF and MF as explained.lab does. Any
                     other script writes to results/<run>/<script name>/, so a
                     variant never overwrites the default's results. One that
                     also binds P = fitPairs(F, G) or H = findPairs(F, G), as
                     pipelines/pairs.lab does both, adds the refit columns:
                     the same gap with the two edges placed jointly against
                     the unblurred image, whether the detector found both or
                     one
  --skip-render      reuse generated/<run>/, re-run the lab and the analysis
  --overwrite        render into generated/<run>/ even though it holds a sweep
  --dry-run          print the shots and stop

Renders are made with LINEAR tone mapping by default, unlike npm run generate.
Under pt-lab's ACES Filmic curve an edge pixel is not the midpoint of its two
sides, and edges land up to ~0.2 px off the geometry -- which is a bias in a
gap. The exposure of 0.5 keeps the brightest measured surface of the gap
scenes (about 1.2 in radiance) clear of clipping. The tone mapping each run
was made with is read from its renders and recorded in gap-sweep.json.

A run name is rendered ONCE. Rendering into a name that already holds a sweep
is refused without --overwrite: path tracing is not byte-reproducible, so a
second render replaces the images the first run's numbers were measured on,
and a later --skip-render then reports different numbers for the "same" run.

The moving part's position in the scene file is taken as CONTACT, gap zero:
scenes/gap-1.json places the Cube resting on the Table with its front face
flush with the table's front edge, so the two edges close onto each other.
`.trim();

function parseArgs(argv) {
  const opts = {
    name: null, scene: 'saved:gap-1', moving: 'Cube', target: 'Table', axis: [0, 1, 0],
    gaps: [50, 20, 10, 5, 2, 1, 0.5, 0], size: 512, samples: 96, skipRender: false, overwrite: false,
    script: DEFAULT_SCRIPT, toneMapping: 'linear', exposure: 0.5,
    yaw: null, elevation: null,
    dryRun: false,
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
      case '--yaw': opts.yaw = list(argv[++i], '--yaw'); break;
      case '--elevation': {
        opts.elevation = list(argv[++i], '--elevation');
        if (opts.elevation.some((e) => e <= -90 || e >= 90)) throw new Error('--elevation must be between -90 and 90');
        break;
      }
      case '--size': opts.size = list(argv[++i], '--size')[0]; break;
      case '--samples': opts.samples = list(argv[++i], '--samples')[0]; break;
      case '--skip-render': opts.skipRender = true; break;
      case '--overwrite': opts.overwrite = true; break;
      case '--script': opts.script = argv[++i]; break;
      case '--tone-mapping': opts.toneMapping = argv[++i]; break;
      case '--exposure': opts.exposure = list(argv[++i], '--exposure')[0]; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  return opts;
}

/**
 * "gap-0p5mm.png": a gap's name, sortable by eye and safe as a file name. On a
 * grid of views it is prefixed with the view, "y20-e15-gap-0p5mm.png"; a
 * negative angle is written m, "em5".
 */
const angleName = (deg) => String(deg).replace('-', 'm').replace('.', 'p');
const shotName = (mm, view) => `${view ? `y${angleName(view.yaw)}-e${angleName(view.elevation)}-` : ''}gap-${String(mm).replace('.', 'p')}mm.png`;

/**
 * One shot per gap, per view; within a view only the moving part's position
 * differs between them.
 */
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
  const views = orbitViews(data.camera, opts) ?? [null];
  return views.flatMap((view) => opts.gaps.map((mm) => ({
    name: shotName(mm, view),
    gapMm: mm,
    // Absent on a sweep with no grid, so its shots.json is the one it always
    // wrote and --skip-render still recognises renders made before grids.
    ...(view ? { view: { yaw: view.yaw, elevation: view.elevation } } : {}),
    camera: view ? view.camera : data.camera.position,
    target: data.camera.target,
    intensity: 1,
    transforms: {
      [opts.moving]: { position: contact.map((c, k) => c + opts.axis[k] * (mm / 1000)) },
    },
  })));
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
    if (!by[s]) throw new Error(`${file} has no ${s} slot -- does the --script bind it as pipelines/explained.lab does?`);
  }
  // P and H are optional: a script that runs fitPairs binds P, one that runs
  // findPairs binds H, and the rows then carry that reading beside the
  // detections' own. Both hold edge-pair records and are read as one list.
  const pairs = by.P || by.H ? [...(by.P ?? []), ...(by.H ?? [])] : null;
  return { truth: by.T, segments: by.F, explained: by.EF, matches: by.MF, pairs };
}

/**
 * SHA-256 of every file the lab reads for each shot: the render, its ground
 * truth, and the three passes. A render is a sample rather than a function of
 * its shot, so these -- not the shot list -- are what make two analyses of
 * one run comparable.
 */
function inputHashes(gen, shots) {
  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
  return Object.fromEntries(shots.map((s) => {
    const base = s.name.replace(/\.png$/, '');
    return [s.name, {
      image: sha(path.join(gen, s.name)),
      truth: sha(path.join(gen, `${base}.gt.json`)),
      depth: sha(path.join(gen, 'aov', `${base}-depth.png`)),
      normal: sha(path.join(gen, 'aov', `${base}-normal.png`)),
      albedo: sha(path.join(gen, 'aov', `${base}-albedo.png`)),
    }];
  }));
}

/**
 * Compare with the previous analysis of this run, if there is one. When the
 * inputs differ its numbers do not carry over, so it is kept beside the new
 * one rather than overwritten, and the run says which shots changed.
 */
function checkPrevious(recordFile, inputs, script) {
  if (!fs.existsSync(recordFile)) return;
  const previous = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  const stamp = (previous.analysedAt ?? fs.statSync(recordFile).mtime.toISOString()).replace(/[:.]/g, '-');
  const kept = recordFile.replace(/\.json$/, `.replaced-${stamp}.json`);
  if (!previous.inputs) {
    fs.renameSync(recordFile, kept);
    console.log(`\nThe previous analysis predates input hashes, so whether it measured these\n`
      + `renders cannot be checked. Kept as ${path.relative(ROOT, kept)}.`);
    return;
  }
  const changed = changedInputs(previous.inputs, inputs);
  // The pipeline is an input too: the same renders through a different
  // script are a different measurement. Records from before scripts were
  // recorded all ran explained.lab, and are not second-guessed.
  if (previous.script && previous.script.sha256 !== script.sha256) {
    const was = previous.script.path === script.path ? `${script.path}, edited` : `${previous.script.path} -> ${script.path}`;
    changed.unshift({ shot: 'the pipeline', files: [was] });
  }
  if (changed.length === 0) return;
  fs.renameSync(recordFile, kept);
  console.log(`\nTHIS IS NOT WHAT THE PREVIOUS ANALYSIS MEASURED -- its numbers do not\n`
    + `carry over. Changed: ${changed.map((c) => `${c.shot} (${c.files.join(', ')})`).join('; ')}.\n`
    + `The previous analysis is kept as ${path.relative(ROOT, kept)}.`);
}

const fmt = (v, d = 2) => (v === null || v === undefined ? '' : Number(v).toFixed(d));

/**
 * The grid as pictures of itself: one small table per quantity, elevation
 * down the side and yaw across the top. The CSV has every number; this is
 * what shows a pattern, and it is written beside it as gap-grid.txt.
 *
 * A cell with no reading says why in one letter rather than standing empty,
 * because "nothing was found" and "there was nothing to find" are different
 * results: `.` the truth has no facing pair in that view, `-` it has one and
 * nothing read it.
 */
function gridMaps(rows, opts) {
  const yaws = [...new Set(rows.map((r) => r.yaw))];
  const elevations = [...new Set(rows.map((r) => r.elevation))];
  // Of a fixture with several pairs, the maps show the first; the CSV has all.
  const cell = (elevation, yaw, gapMm) => rows.find((r) => r.elevation === elevation && r.yaw === yaw && r.gapMm === gapMm);
  const table = (title, gapMm, value) => {
    const lines = [title, `  elev \\ yaw ${yaws.map((y) => String(y).padStart(8)).join('')}`];
    for (const e of elevations) {
      lines.push(`  ${String(e).padStart(10)} ${yaws.map((y) => {
        const r = cell(e, y, gapMm);
        if (!r || r.trueGapPx === null) return '.'.padStart(8);
        const v = value(r);
        return (v === null || v === undefined ? '-' : v).padStart(8);
      }).join('')}`);
    }
    return lines.join('\n');
  };
  const anyGap = opts.gaps.find((g) => g > 0);
  const out = [];
  if (anyGap !== undefined) {
    out.push(table('pixels per millimetre of gap', anyGap, (r) => fmt(r.pxPerMm, 3)));
    out.push(table('length the two edges share, px', anyGap, (r) => fmt(r.overlapPx, 0)));
  }
  for (const g of opts.gaps) {
    if (!(g > 0)) continue;
    out.push(table(`${g} mm: gap error as detected, mm`, g, (r) => (r.errorMm === null ? null : fmt(r.errorMm, 3))));
    if (rows.some((r) => r.refit)) {
      out.push(table(`${g} mm: gap error refit, mm (* found inside one segment)`, g,
        (r) => (r.refit ? `${fmt(r.refit.errorMm, 3)}${r.refit.from === 'segment' ? '*' : ''}` : null)));
    }
  }
  return out.join('\n\n');
}

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
  // A non-default script gets its own results directory, so a variant can
  // never overwrite the default's numbers under the same run name.
  if (!fs.existsSync(path.resolve(ROOT, opts.script))) throw new Error(`no such script: ${opts.script}`);
  const scriptName = path.basename(opts.script).replace(/\.lab$/, '');
  const res = path.resolve(ROOT, opts.script) === path.join(ROOT, DEFAULT_SCRIPT)
    ? path.join('results', opts.name)
    : path.join('results', opts.name, scriptName);
  const shots = gapShots(opts);

  if (opts.dryRun) {
    for (const s of shots) {
      console.log(`${s.name.padEnd(s.view ? 28 : 16)} ${opts.moving} at ${s.transforms[opts.moving].position.map((v) => v.toFixed(4)).join(', ')}`
        + (s.view ? `   camera at ${s.camera.map((v) => v.toFixed(4)).join(', ')}` : ''));
    }
    return;
  }

  const shotsFile = path.join(gen, 'shots.json');
  if (opts.skipRender) {
    // Reusing renders is only honest if they are the renders of these shots.
    const had = fs.existsSync(path.join(ROOT, shotsFile)) && fs.readFileSync(path.join(ROOT, shotsFile), 'utf8');
    if (had !== JSON.stringify(shots, null, 2)) {
      throw new Error(`${shotsFile} is not these shots; render them under a new --name`);
    }
  } else {
    /*
     * A name is rendered once. This is not tidiness: on 2026-09-30 a second
     * run under an existing name replaced the renders, the next --skip-render
     * re-analysed the replacements, and the numbers moved -- which read as a
     * determinism failure in the lab until the file times gave it away.
     */
    if (fs.existsSync(path.join(ROOT, shotsFile)) && !opts.overwrite) {
      const when = fs.statSync(path.join(ROOT, shotsFile)).mtime.toISOString();
      throw new Error(`${gen} already holds a sweep, rendered ${when}.\n`
        + 'Rendering again replaces the images its results were measured on, and path\n'
        + 'tracing is not byte-reproducible, so the numbers would move. Use a new --name,\n'
        + '--skip-render to re-analyse these renders, or --overwrite to replace them.');
    }
    fs.mkdirSync(path.join(ROOT, gen), { recursive: true });
    fs.writeFileSync(path.join(ROOT, shotsFile), JSON.stringify(shots, null, 2));
    electron('scripts/generate-cli.js', [
      '--out', gen, '--scene', opts.scene, '--shots', shotsFile,
      '--size', String(opts.size), '--samples', String(opts.samples), '--truth', '--aovs',
      '--tone-mapping', opts.toneMapping, '--exposure', String(opts.exposure),
    ]);
  }

  const images = shots.map((s) => path.join(gen, s.name));
  electron('scripts/lab-cli.js', [
    '--script', opts.script, '--as', 'linear',
    '--truth', gen, '--aovs', gen, '--out', res, '--quiet', ...images,
  ]);

  const overlays = path.join(res, 'overlays');
  for (const image of images) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/overlay.js'), image, res, overlays],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) throw new Error(`overlay of ${image} failed`);
  }

  const parts = { moving: opts.moving, target: opts.target };
  // One row per facing pair per shot: a fixture with two pairs -- a cube
  // stacked on a cube -- gets two rows a shot, and each is its own measurement.
  const rows = shots.flatMap((s) => gapRows(
    slots(path.join(ROOT, res, s.name.replace(/\.png$/, '.features.json'))), s, parts,
  ).map((r) => ({ ...(s.view ?? {}), ...r })));
  const paired = rows.some((r) => r.pair > 1);
  /*
   * Pixels per millimetre is a property of the VIEW: the same gap is fewer
   * pixels the more nearly the camera looks along it. So it is taken per view,
   * and an error in millimetres is that view's error. And of the PAIR, where
   * there is more than one: two pairs at right angles see the same gap from
   * different sides.
   */
  const gridded = shots.some((s) => s.view);
  const viewKey = (r) => `${gridded ? `${r.yaw},${r.elevation}` : ''}/${r.pair ?? ''}`;
  const scales = new Map();
  for (const key of new Set(rows.map(viewKey))) scales.set(key, pxPerMm(rows.filter((r) => viewKey(r) === key)));
  for (const r of rows) {
    const s = scales.get(viewKey(r));
    r.pxPerMm = s;
    r.errorMm = s && r.errorPx !== null ? r.errorPx / s : null;
    if (r.refit) r.refit.errorMm = s ? r.refit.errorPx / s : null;
  }
  const scale = gridded || paired ? null : scales.get(viewKey(rows[0]));

  const inputs = inputHashes(gen, shots);
  const recordFile = path.join(ROOT, res, 'gap-sweep.json');
  const script = {
    path: path.relative(ROOT, path.resolve(ROOT, opts.script)),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(ROOT, opts.script))).digest('hex'),
  };
  checkPrevious(recordFile, inputs, script);
  // From the renders, not from the options: a --skip-render reuses whatever
  // they were made with. Renders from before 2026-10-01 carry nothing and
  // were all ACES at exposure 1.
  const firstTruth = JSON.parse(fs.readFileSync(path.join(ROOT, gen, shots[0].name.replace(/\.png$/, '.gt.json')), 'utf8'));
  const toneMapping = firstTruth.toneMapping ?? { kind: 'aces', exposure: 1, assumed: true };
  const record = {
    scene: opts.scene, ...parts, axis: opts.axis, size: opts.size, samples: opts.samples, toneMapping,
    camera: gridded ? null : shots[0].camera, look: shots[0].target, pxPerMm: scale,
    ...(gridded ? { views: { yaw: opts.yaw, elevation: opts.elevation } } : {}),
    analysedAt: new Date().toISOString(), script, inputs, rows,
  };
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));

  const causes = [...new Set(rows.flatMap((r) => Object.keys(r.causes)))].sort();
  // The refit columns exist only when the script ran fitPairs or findPairs, so the
  // default pipeline's table is the table it always was.
  const refitted = shots.some((s) => slots(path.join(ROOT, res, s.name.replace(/\.png$/, '.features.json'))).pairs);
  const refitHead = refitted
    ? ['refitGapPx', 'refitErrorPx', 'refitErrorMm', `refit${opts.moving}OffsetPx`, `refit${opts.target}OffsetPx`, 'gapSigma', 'stripLevel', 'refitFrom']
    : [];
  const refitCells = (r) => (refitted
    ? [fmt(r.refit?.gapPx, 3), fmt(r.refit?.errorPx, 3), fmt(r.refit?.errorMm, 3), fmt(r.refit?.movingOffsetPx, 3),
      fmt(r.refit?.targetOffsetPx, 3), fmt(r.refit?.gapSigma, 3), fmt(r.refit?.stripLevel, 3), r.refit?.from ?? '']
    : []);
  const viewHead = [...(gridded ? ['yaw', 'elevation'] : []), ...(paired ? ['pair'] : []),
    ...(gridded || paired ? ['pxPerMm', 'overlapPx'] : [])];
  const viewCells = (r) => [...(gridded ? [r.yaw, r.elevation] : []), ...(paired ? [r.pair ?? ''] : []),
    ...(gridded || paired ? [fmt(r.pxPerMm, 3), fmt(r.overlapPx, 1)] : [])];
  const head = [...viewHead, 'gapMm', 'trueGapPx', 'measuredGapPx', 'errorPx', 'errorMm',
    `${opts.moving}OffsetPx`, `${opts.target}OffsetPx`, ...refitHead, 'pairFound', 'spansBoth',
    `${opts.moving}Found`, `${opts.target}Found`, ...causes.map((c) => `inGap_${c}`), 'reason'];
  const body = rows.map((r) => [
    ...viewCells(r), r.gapMm, fmt(r.trueGapPx, 3), fmt(r.measuredGapPx, 3), fmt(r.errorPx, 3), fmt(r.errorMm, 3),
    fmt(r.movingOffsetPx, 3), fmt(r.targetOffsetPx, 3), ...refitCells(r), r.pairFound, r.spansBoth, `${r.moving.found}/${r.moving.findable}`, `${r.target.found}/${r.target.findable}`,
    ...causes.map((c) => r.causes[c] ?? 0),
    // Unquoted, so the padding below stays valid CSV: a quote must open its
    // field, and a padded field would start with spaces. No reason contains a
    // comma today; this keeps it so.
    (r.reason ?? '').replace(/,/g, ';'),
  ].map(String));
  /*
   * Laid out to be read as well as parsed: ", " between fields, and every
   * column right-aligned to its widest entry, header included. A reader that
   * trims leading spaces (pandas' skipinitialspace, a spreadsheet's import)
   * gets the plain values back.
   */
  const widths = head.map((h, k) => Math.max(h.length, ...body.map((cells) => cells[k].length)));
  const line = (cells) => cells.map((c, k) => c.padStart(widths[k])).join(', ');
  const csv = [line(head), ...body.map(line)];
  fs.writeFileSync(path.join(ROOT, res, 'gap-sweep.csv'), `${csv.join('\n')}\n`);

  console.log(`\n${opts.scene}: ${opts.moving} closing on ${opts.target}, ${opts.size}px, `
    + `${opts.samples} samples, ${toneMapping.kind} tone mapping at exposure ${toneMapping.exposure}`
    + `${toneMapping.assumed ? ' (assumed: the renders predate recording it)' : ''}, `
    + (gridded ? `${new Set(rows.map((r) => `${r.yaw},${r.elevation}`)).size} views`
      : paired ? `${Math.max(...rows.map((r) => r.pair ?? 0))} facing pairs` : `${fmt(scale, 3)} px per mm of gap`));
  console.log(csv.join('\n'));
  if (gridded) {
    const maps = gridMaps(rows, opts);
    fs.writeFileSync(path.join(ROOT, res, 'gap-grid.txt'), `${maps}\n`);
    console.log(`\n${maps}`);
  }
  console.log(`\n${res}/gap-sweep.csv, gap-sweep.json, ${gridded ? 'gap-grid.txt, ' : ''}overlays/`);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
