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
const { movingBelow } = require('./ledge');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { resolveScene } = require('../src/generate/driver');
const { gapRows, numberPairs, pxPerMm, pxPerMmSlope, changedInputs, orbitViews } = require('../src/lab/gapsweep');

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
  --poses <x,y,z[,turn[,tipX,tipZ]];...>
                     instead of a sweep, a list of poses: each a displacement
                     from contact in millimetres and, optionally, a turn about
                     the vertical in degrees, and a tip about the x and the z
                     axis, in degrees (the part's Euler rotation, about its own
                     centre). One shot per pose per view, named pose-1.png and
                     on. For poses off the axes, and turned or tipped ones
  --offset <x,y,z>   millimetres added to every step, on top of the sweep along
                     --axis. For sweeping a direction that does not open the
                     gap: lift the part 2 mm with --offset 0,2,0 and slide it
                     sideways with --axis 1,0,0 --gaps -5,-2,0,2,5. Steps may be
                     negative only with an offset; without one, a negative
                     step is the part inside the other
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
  --carry            hold each pair's still edge where one frame read it
                     cleanly: per view and pair, the widest frame whose refit
                     read it as a detected pair, with no ledge in it, gives the
                     still part's edge, the strip level and the aperture; every
                     frame of that view runs again with a trackPair command
                     holding that edge (and, where the frame's own gap is
                     narrow, that level). Adds the tracked columns. Needs a
                     script binding G and P = fitPairs(F, G)
  --carry-from <dir> take the still edges from these --carry runs' frames
                     instead (results directories, repeatable; this run's own
                     frames count only if its own directory is named). The
                     still part and the cameras are the same in every run, so
                     a view's still edge is one line: runs given the same list
                     hold the same edge, and a calibration made from them
                     absorbs whatever offset that edge has. For views whose
                     own frames have nothing to carry from, and for a run of
                     one pose, as a closed loop renders. Pairs are matched by
                     the angle they run at, within 10 degrees
  --max-angle <deg>  how far from parallel a truth pair's two edges may be and
                     still be scored as a pair             (default 5). A part
                     turned past that has no row, whatever its track read
  --carry-min <px>   how wide a gap must be to be carried from, or to fit its
                     own strip level                      (default 3)
  --ledge-max <x>    a frame whose fitPairs ledge gain reaches this is not
                     carried from                         (default 1.2)
  --ledge-fit        also fit each carried pair with its ledge free
                     (L<pair> = trackPair(..., ledge=fit)), for npm run ledge
                     to measure the shadow's width from. Slow; sharp images
  --ledge <file>     hold a ledge in every carried pair: npm run ledge's
                     table, matched by view and the angle a pair runs at.
                     Where it ends follows the frame's COMMANDED lift, so the
                     moving part must be the one above
  --ledge-lift <mm>  the lift to place the ledge at, for every shot, instead
                     of the shot's own: a closed loop renders the part where
                     it really is and knows only where it believes it is
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
    gaps: [50, 20, 10, 5, 2, 1, 0.5, 0], carryFrom: [], size: 512, samples: 96, skipRender: false, overwrite: false,
    script: DEFAULT_SCRIPT, toneMapping: 'linear', exposure: 0.5,
    yaw: null, elevation: null, offset: null, poses: null,
    carry: false, carryMin: 3, ledgeMax: 1.2, ledgeFit: false, ledge: null, ledgeLift: null, dryRun: false,
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
      case '--gaps': opts.gaps = list(argv[++i], '--gaps'); break;
      case '--poses': {
        opts.poses = String(argv[++i]).split(';').filter((p) => p.trim()).map((p) => {
          const v = list(p, '--poses');
          if (![3, 4, 6].includes(v.length)) throw new Error(`--poses: "${p}" needs x,y,z or x,y,z,turn or x,y,z,turn,tipX,tipZ`);
          return { mm: v.slice(0, 3), turn: v[3] ?? 0, tip: [v[4] ?? 0, v[5] ?? 0] };
        });
        if (opts.poses.length === 0) throw new Error('--poses needs at least one pose');
        break;
      }
      case '--offset': {
        opts.offset = list(argv[++i], '--offset');
        if (opts.offset.length !== 3) throw new Error('--offset needs three numbers, in millimetres');
        if (opts.offset.every((v) => v === 0)) opts.offset = null;
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
      case '--carry': opts.carry = true; break;
      case '--carry-from': opts.carryFrom.push(argv[++i]); break;
      case '--max-angle': opts.maxAngle = list(argv[++i], '--max-angle')[0]; break;
      case '--carry-min': opts.carryMin = list(argv[++i], '--carry-min')[0]; break;
      case '--ledge-max': opts.ledgeMax = list(argv[++i], '--ledge-max')[0]; break;
      case '--ledge-fit': opts.ledgeFit = true; break;
      case '--ledge': opts.ledge = argv[++i]; break;
      case '--ledge-lift': opts.ledgeLift = list(argv[++i], '--ledge-lift')[0]; break;
      case '--overwrite': opts.overwrite = true; break;
      case '--script': opts.script = argv[++i]; break;
      case '--tone-mapping': opts.toneMapping = argv[++i]; break;
      case '--exposure': opts.exposure = list(argv[++i], '--exposure')[0]; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  // Checked once every option is in, since they depend on each other.
  if (opts.carryFrom.length && !opts.carry) throw new Error('--carry-from needs --carry');
  if ((opts.ledgeFit || opts.ledge) && !opts.carry) throw new Error('--ledge and --ledge-fit need --carry: they are read beside the carried edge');
  if (opts.ledgeLift !== null && !opts.ledge) throw new Error('--ledge-lift needs --ledge');
  if (opts.poses && opts.offset) throw new Error('--poses are displacements from contact; --offset does not apply');
  if (!opts.poses && !opts.offset && opts.gaps.some((v) => v < 0)) {
    throw new Error('--gaps cannot be negative without --offset: that is the part inside the other');
  }
  return opts;
}

/**
 * "gap-0p5mm.png": a gap's name, sortable by eye and safe as a file name. On a
 * grid of views it is prefixed with the view, "y20-e15-gap-0p5mm.png"; a
 * negative angle is written m, "em5".
 */
const angleName = (deg) => String(deg).replace('-', 'm').replace('.', 'p');
const shotName = (mm, view) => `${view ? `y${angleName(view.yaw)}-e${angleName(view.elevation)}-` : ''}gap-${angleName(mm)}mm.png`;

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
  if (opts.poses) {
    /*
     * A pose is a displacement from contact and a turn about the vertical,
     * placed as it is -- not a step along anything. gapMm is 0 for all of
     * them: nothing is being swept, and the pose is in its own fields.
     */
    const turned = (moving.transform.rotation ?? [0, 0, 0]);
    return views.flatMap((view) => opts.poses.map((p, k) => ({
      name: `${view ? `y${angleName(view.yaw)}-e${angleName(view.elevation)}-` : ''}pose-${k + 1}.png`,
      gapMm: 0,
      pose: k + 1,
      poseMm: p.mm,
      turnDeg: p.turn,
      ...(p.tip[0] || p.tip[1] ? { tipDeg: p.tip } : {}),
      ...(view ? { view: { yaw: view.yaw, elevation: view.elevation } } : {}),
      camera: view ? view.camera : data.camera.position,
      target: data.camera.target,
      intensity: 1,
      separationMm: Math.hypot(...p.mm),
      transforms: {
        [opts.moving]: {
          position: contact.map((c, j) => c + p.mm[j] / 1000),
          rotation: [turned[0] + p.tip[0], turned[1] + p.turn, turned[2] + p.tip[1]],
        },
      },
    })));
  }
  return views.flatMap((view) => opts.gaps.map((mm) => ({
    name: shotName(mm, view),
    gapMm: mm,
    // Absent on a sweep with no grid, so its shots.json is the one it always
    // wrote and --skip-render still recognises renders made before grids.
    ...(view ? { view: { yaw: view.yaw, elevation: view.elevation } } : {}),
    camera: view ? view.camera : data.camera.position,
    target: data.camera.target,
    intensity: 1,
    // With an offset the swept step is not the distance between the parts;
    // this is, and the analysis needs it to say which edges are near in depth.
    ...(opts.offset ? { separationMm: Math.hypot(...opts.offset.map((o, k) => o + opts.axis[k] * mm)) } : {}),
    transforms: {
      [opts.moving]: {
        position: contact.map((c, k) => c + ((opts.offset?.[k] ?? 0) + opts.axis[k] * mm) / 1000),
      },
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
  // K1, K2, ...: trackPair's, written by --carry. Read as one list too; which
  // speaks for which pair is decided by where its line lies (gapsweep.js).
  const tracked = Object.keys(by).filter((k) => /^K\d+$/.test(k));
  const tracks = tracked.length ? tracked.flatMap((k) => by[k]) : null;
  // L1, L2, ...: the free ledge fits --ledge-fit asks for, beside them.
  const fits = Object.keys(by).filter((k) => /^L\d+$/.test(k));
  const ledgeFits = fits.length ? fits.flatMap((k) => by[k]) : null;
  return { truth: by.T, segments: by.F, explained: by.EF, matches: by.MF, pairs, fitted: by.P ?? null, tracks, ledgeFits };
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
/** Is there more than one scale in this sweep, so that the record carries none? */
const perKeyScale = (gridded, paired, opts) => gridded || paired || !!opts.offset;

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
    if (rows.some((r) => r.tracked)) {
      out.push(table(`${g} mm: gap error tracked from a wider frame, mm`, g,
        (r) => (r.tracked ? fmt(r.tracked.errorMm, 3) : null)));
    }
  }
  return out.join('\n\n');
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[(s.length - 1) >> 1] : null; };
/** Degrees between two directions in the image, round the 0/180 join. */
const angleApart = (a, b) => Math.abs((((a - b + 90) % 180) + 180) % 180 - 90);

/**
 * Another --carry run's candidates for carrying from, placed as carryPlan
 * places its own: frames whose refit read a pair as two detected edges at
 * least carryMin px apart, with no ledge. Its rows name no shot before
 * 2026-10-05, so the name is rebuilt from the row the way gapShots made it.
 */
function pooledCandidates(dir, opts) {
  const record = JSON.parse(fs.readFileSync(path.resolve(ROOT, dir, 'gap-sweep.json'), 'utf8'));
  const out = [];
  for (const row of record.rows) {
    if (!(row.refit?.from === 'pair' && row.refit.gapPx >= opts.carryMin) || row.refit.ledge?.gain >= opts.ledgeMax) continue;
    const view = row.yaw === undefined ? null : { yaw: row.yaw, elevation: row.elevation };
    const name = row.shot ?? (row.pose !== undefined
      ? `${view ? `y${angleName(view.yaw)}-e${angleName(view.elevation)}-` : ''}pose-${row.pose}.png`
      : shotName(row.gapMm, view));
    const file = path.resolve(ROOT, dir, name.replace(/\.png$/, '.features.json'));
    if (!fs.existsSync(file)) continue;
    const fitted = (slots(file).fitted ?? []).find((p) => p.id === row.refit.pair);
    if (!fitted) continue;
    const [moving, still] = fitted.a.segment === row.detectedPair[1] ? [fitted.b, fitted.a] : [fitted.a, fitted.b];
    out.push({ view: `${row.yaw ?? ''},${row.elevation ?? ''}`, pairAngle: row.pairAngle,
      s: { name, gapMm: row.gapMm, run: path.relative(ROOT, path.resolve(ROOT, dir)), ...(view ? { view } : {}) },
      row, record: fitted, moving, still });
  }
  return out;
}

/**
 * What --carry writes into each frame.
 *
 * For every view and every pair, ONE frame is carried from: of the frames
 * whose refit read the pair as two detected edges at least `carryMin` px
 * apart with no ledge in them (fitPairs's `ledge.gain` under `ledgeMax`),
 * the one whose still edge is the median of theirs. Its fitPairs record gives the still part's edge, a point on
 * the moving side, the strip level and the aperture. Every frame of that view,
 * in any order, then reads the pair again with `K<pair> = trackPair(G, ...)`:
 *
 *   - the still edge HELD, everywhere. The still part does not move, and a
 *     frame where a ledge in soft shadow lies along its edge cannot place it
 *     (design-lab-model.md §5, the fifteenth); a frame without one can;
 *   - the strip FITTED where the frame read the pair at least `carryMin` px
 *     wide itself, and HELD at the carried level where it did not: under
 *     about a pixel and a half, width and level trade (the twelfth).
 *
 * A pair with no frame to carry from -- every wide frame has a ledge, or none
 * is wide -- gets nothing, and the plan says so.
 *
 * `pooled` are candidates from other runs (--carry-from), each already
 * placed: the same view, matched to a pair here by the angle it runs at.
 * Given any, this run's own frames are candidates only if `ownToo`.
 */
/** trackPair's starting width from a frame's own reading, which may be an overhang's negative one. */
const guessFrom = (read) => (read > 0 ? read : 0.5);

function carryPlan(rows, shots, featuresOf, opts, pooled = null, ownToo = true, ownRun = '', ledgeTable = null) {
  // Whose top face a ledge is: the still part's, unless the moving part is below it.
  const below = movingBelow({ offsetMm: opts.offset, axis: opts.axis, poses: opts.poses });
  for (const e of ledgeTable?.entries ?? []) {
    if ((e.on ?? 'still') !== (below ? 'moving' : 'still')) {
      throw new Error(`--ledge ${opts.ledge}: measured with the moving part ${e.on === 'moving' ? 'below' : 'above'} the still one, and this run has it ${below ? 'below' : 'above'}`);
    }
  }
  const viewOf = (x) => `${x.view?.yaw ?? x.yaw ?? ''},${x.view?.elevation ?? x.elevation ?? ''}`;
  const n = (v) => v.toFixed(6);
  const shotOf = (s) => (r) => r.gapMm === s.gapMm && (s.pose === undefined || r.pose === s.pose);
  const commands = {};
  const sources = [];
  const missing = [];
  const ledges = [];
  for (const view of new Set(shots.map(viewOf))) {
    const frames = shots.filter((s) => viewOf(s) === view);
    const pairs = [...new Set(rows.filter((r) => viewOf(r) === view && r.pair).map((r) => r.pair))].sort((a, b) => a - b);
    for (const pair of pairs) {
      const rowIn = (s) => rows.find((r) => viewOf(r) === view && r.pair === pair && shotOf(s)(r));
      const candidates = (ownToo ? frames : []).map((s) => ({ s, row: rowIn(s) }))
        .filter(({ row }) => row?.refit?.from === 'pair' && row.refit.gapPx >= opts.carryMin)
        .filter(({ row }) => !(row.refit.ledge?.gain >= opts.ledgeMax))
        .sort((a, b) => b.row.refit.gapPx - a.row.refit.gapPx);
      // Each candidate's still edge, from its fitPairs record. detectedPair is
      // [moving, target]; the record's edges name segments.
      const placed = candidates.map((c) => {
        const record = (featuresOf(c.s).fitted ?? []).find((p) => p.id === c.row.refit.pair);
        if (!record) return null;
        const [moving, still] = record.a.segment === c.row.detectedPair[1] ? [record.b, record.a] : [record.a, record.b];
        return { ...c, record, moving, still };
      }).filter(Boolean);
      const angle = median(rows.filter((r) => viewOf(r) === view && r.pair === pair && r.pairAngle != null).map((r) => r.pairAngle));
      placed.push(...(pooled ?? []).filter((c) => c.view === view && angle !== null && angleApart(c.pairAngle, angle) <= 10));
      if (placed.length === 0) { missing.push({ view, pair }); continue; }
      // In a fixed order before anything is measured against the first, so
      // that runs given the same candidates choose the same one.
      const order = (c) => `${c.s.run ?? ownRun}/${c.s.name}`;
      placed.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
      /*
       * The median of them, not the widest. A mild ledge can stay under
       * ledgeMax and still move its frame's still edge 0.1 px: on the x
       * sweep the widest frame under it read that edge 0.09 to 0.13 px off,
       * and every frame carried it. Ordered by where each puts the still edge
       * -- its offset along the first one's normal at the first one's middle
       * -- the middle one is outvoted by nothing.
       */
      const ref = placed[0].still;
      const len = Math.hypot(ref.x1 - ref.x0, ref.y1 - ref.y0);
      const normal = [-(ref.y1 - ref.y0) / len, (ref.x1 - ref.x0) / len];
      const m = [(ref.x0 + ref.x1) / 2, (ref.y0 + ref.y1) / 2];
      const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
      // Where line e crosses the normal through ref's middle, along that normal.
      const offsetOf = (e) => {
        const u = [e.x1 - e.x0, e.y1 - e.y0];
        return cross([e.x0 - m[0], e.y0 - m[1]], u) / cross(normal, u);
      };
      placed.sort((a, b) => offsetOf(a.still) - offsetOf(b.still));
      const { s: from, row, record, moving, still } = placed[(placed.length - 1) >> 1];
      const carried = { line: still, toward: [(moving.x0 + moving.x1) / 2, (moving.y0 + moving.y1) / 2],
        stripLevel: record.levels[1], aperture: record.aperture, profile: record.profile ?? 'box' };
      sources.push({ ...(from.view ?? {}), pair, ...(from.run ? { run: from.run } : {}), from: from.name, fromMm: from.gapMm, gapPx: row.refit.gapPx,
        ledgeGain: row.refit.ledge?.gain ?? null, of: placed.length, stripLevel: carried.stripLevel, aperture: carried.aperture });
      // The ledge this view-pair has, from --ledge's file, matched like the
      // pooled edges by the angle the pair runs at.
      const ledge = (ledgeTable?.entries ?? []).find((e) => `${e.yaw},${e.elevation}` === view
        && angle !== null && angleApart(e.pairAngle, angle) <= 10) ?? null;
      if (ledgeTable) ledges.push({ view, pair, ...(ledge ? { flush: ledge.flush, widthPerMm: ledge.widthPerMm } : { none: true }) });
      for (const s of frames) {
        const own = rowIn(s);
        const read = own?.refit?.gapPx ?? own?.measuredGapPx ?? null;
        const wide = read !== null && read >= opts.carryMin;
        const common = `x0=${n(carried.line.x0)}, y0=${n(carried.line.y0)}, `
          + `x1=${n(carried.line.x1)}, y1=${n(carried.line.y1)}, towardX=${n(carried.toward[0])}, `
          + `towardY=${n(carried.toward[1])}, stripLevel=${n(carried.stripLevel)}, aperture=${n(carried.aperture)}, `
          // A start, not a reading: an overhang's negative refit starts at half a pixel.
          + `guess=${n(guessFrom(read ?? row.refit.gapPx))}, strip=${wide ? 'fit' : 'held'}`
          + `${carried.profile !== 'box' ? `, profile=${carried.profile}` : ''}`
          // The moving part below the still one: see trackPair's `moving`.
          + `${below ? ', moving=below' : ''}`;
        /*
         * The ledge, held: it ends where the still edge would be were the
         * moving part flush at this frame's lift -- the y sweep's gap at
         * that lift -- so a frame at flush has none, and one slid back has
         * as much as it slid. The shadow's width grows with the lift as a
         * penumbra does. The lift is the commanded one: what the robot was
         * told, not where the part is (design-lab-model.md §5, "A
         * thirty-second").
         */
        // The lift is how far the upper part is above the lower: the moving
        // part's own rise, or, when it is the one below, its drop.
        const lift = opts.ledgeLift ?? (below ? -1 : 1) * displacementOf(s, opts)[1];
        const offset = ledge ? ledge.flush[0] * lift + ledge.flush[1] : null;
        const held = offset > 0
          ? `, ledge=held, ledgeOffset=${n(offset)}, ledgeWidth=${n(Math.max(0, ledge.widthPerMm * lift))}` : '';
        const list = (commands[s.name.replace(/\.png$/, '')] ??= []);
        list.push(`K${pair} = trackPair(G, ${common}${held})`);
        if (opts.ledgeFit) list.push(`L${pair} = trackPair(G, ${common}, ledge=fit)`);
      }
    }
  }
  return { minPx: opts.carryMin, ledgeMax: opts.ledgeMax, sources, missing, commands, ...(ledgeTable ? { ledges } : {}) };
}

/** The moving part's displacement from contact for a shot, mm: its pose, or the sweep's step. */
function displacementOf(s, opts) {
  if (s.poseMm) return s.poseMm;
  return [0, 1, 2].map((k) => (opts.offset?.[k] ?? 0) + opts.axis[k] * s.gapMm);
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
  const posed = !!opts.poses;

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
  const lab = (extra = [], only = images) => electron('scripts/lab-cli.js', [
    '--script', opts.script, '--as', 'linear',
    '--truth', gen, '--aovs', gen, '--out', res, '--quiet', ...extra, ...only,
  ]);
  lab();

  const parts = { moving: opts.moving, target: opts.target };
  const featuresOf = (s) => slots(path.join(ROOT, res, s.name.replace(/\.png$/, '.features.json')));
  const analyse = () => {
    // One row per facing pair per shot: a fixture with two pairs -- a cube
    // stacked on a cube -- gets two rows a shot, and each is its own measurement.
    const perShot = shots.flatMap((s) => gapRows(featuresOf(s), s, parts, opts.maxAngle ? { maxAngle: opts.maxAngle } : {}).map((r) => ({
      shot: s.name,
      ...(s.view ?? {}),
      ...(s.pose ? { pose: s.pose, poseMm: s.poseMm, turnDeg: s.turnDeg, ...(s.tipDeg ? { tipDeg: s.tipDeg } : {}) } : {}),
      ...r,
    })));
    // Renumbered a view at a time, so that pair 1 is one pair down the sweep
    // even through the shots that lost the other.
    const viewOf = (r) => `${r.yaw ?? ''},${r.elevation ?? ''}`;
    const numbered = new Map([...new Set(perShot.map(viewOf))]
      .map((v) => [v, numberPairs(perShot.filter((r) => viewOf(r) === v))]));
    const taken = new Map();
    return perShot.map((r) => {
      const k = taken.get(viewOf(r)) ?? 0;
      taken.set(viewOf(r), k + 1);
      return numbered.get(viewOf(r))[k];
    });
  };
  let rows = analyse();

  /*
   * --carry: a second pass over the frames that have something carried into
   * them, the same script and then their trackPair commands, so each carried
   * number is in that frame's log. The first pass's slots come out the same
   * (the lab is deterministic); the K slots are new. Then analysed again.
   */
  let carry = null;
  if (opts.carry) {
    if (!shots.some((s) => featuresOf(s).fitted)) throw new Error('--carry needs a script that binds P = fitPairs(F, G)');
    if (!/^\s*G\s*=/m.test(fs.readFileSync(path.resolve(ROOT, opts.script), 'utf8'))) {
      throw new Error('--carry runs trackPair(G, ...): the script must bind G, the gray image before the blur');
    }
    // This run's own directory among --carry-from is its own frames, read
    // fresh; the others are read from their records.
    const own = (d) => path.resolve(ROOT, d) === path.resolve(ROOT, res);
    const ledgeTable = opts.ledge ? JSON.parse(fs.readFileSync(path.resolve(ROOT, opts.ledge), 'utf8')) : null;
    carry = opts.carryFrom.length
      ? carryPlan(rows, shots, featuresOf, opts, opts.carryFrom.filter((d) => !own(d)).flatMap((d) => pooledCandidates(d, opts)),
        opts.carryFrom.some(own), res, ledgeTable)
      : carryPlan(rows, shots, featuresOf, opts, null, true, '', ledgeTable);
    // What was carried from where, and the commands it became: the latter in
    // the form lab-cli's --extra reads.
    fs.writeFileSync(path.join(ROOT, res, 'carry.json'),
      `${JSON.stringify({ minPx: carry.minPx, ledgeMax: carry.ledgeMax, sources: carry.sources, missing: carry.missing,
        ...(carry.ledges ? { ledge: { file: opts.ledge, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(ROOT, opts.ledge))).digest('hex'), pairs: carry.ledges } } : {}) }, null, 2)}\n`);
    if (carry.missing.length) console.log(`--carry: nothing to carry from for ${carry.missing.map((m) => `${m.view} pair ${m.pair}`).join('; ')}`);
    const commandsFile = path.join(res, 'carry-commands.json');
    fs.writeFileSync(path.join(ROOT, commandsFile), `${JSON.stringify(carry.commands, null, 2)}\n`);
    const later = shots.filter((s) => carry.commands[s.name.replace(/\.png$/, '')]).map((s) => path.join(gen, s.name));
    if (later.length > 0) lab(['--extra', commandsFile], later);
    rows = analyse();
    for (const r of rows) {
      const from = carry.sources.find((c) => c.yaw === r.yaw && c.elevation === r.elevation && c.pair === r.pair);
      if (r.tracked && from) { r.tracked.carriedFrom = from.from; r.tracked.carriedFromMm = from.fromMm; }
    }
  }

  const overlays = path.join(res, 'overlays');
  for (const image of images) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/overlay.js'), image, res, overlays],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) throw new Error(`overlay of ${image} failed`);
  }

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
  /*
   * With an offset, the sweep runs ACROSS a gap that is already open, so the
   * image gap is not zero at step zero and a ratio means nothing. Its slope
   * against the step does: how many pixels this pair's gap moves per
   * millimetre in the swept direction, signed -- and near zero for a pair
   * that cannot see that direction at all, which is a result and not a fault.
   */
  const scaleOf = opts.offset ? pxPerMmSlope : pxPerMm;
  const scales = new Map();
  for (const key of new Set(rows.map(viewKey))) scales.set(key, scaleOf(rows.filter((r) => viewKey(r) === key)));
  for (const r of rows) {
    const s = scales.get(viewKey(r));
    r.pxPerMm = s;
    // Under a twentieth of a pixel per millimetre the pair is not measuring
    // this direction, and dividing by it would print millimetres it has no
    // claim to.
    const usable = s !== null && Math.abs(s) >= 0.05;
    r.errorMm = usable && r.errorPx !== null ? r.errorPx / s : null;
    if (r.refit) r.refit.errorMm = usable ? r.refit.errorPx / s : null;
    if (r.tracked) r.tracked.errorMm = usable ? r.tracked.errorPx / s : null;
  }
  const scale = perKeyScale(gridded, paired, opts) ? null : scales.get(viewKey(rows[0]));

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
    ...(opts.offset ? { offsetMm: opts.offset } : {}),
    ...(posed ? { poses: opts.poses } : {}),
    ...(carry ? { carry: { minPx: carry.minPx, ledgeMax: carry.ledgeMax, sources: carry.sources, missing: carry.missing,
      ...(carry.ledges ? { ledge: { file: opts.ledge, pairs: carry.ledges } } : {}), ...(opts.ledgeFit ? { ledgeFit: true } : {}) } } : {}),
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
  const trackedAny = rows.some((r) => r.tracked);
  const trackHead = trackedAny ? ['trackedGapPx', 'trackedErrorPx', 'trackedErrorMm', 'trackedSigma', 'trackedRms'] : [];
  const trackCells = (r) => (trackedAny
    ? [fmt(r.tracked?.gapPx, 3), fmt(r.tracked?.errorPx, 3), fmt(r.tracked?.errorMm, 3), fmt(r.tracked?.gapSigma, 3),
      fmt(r.tracked?.rms, 4)]
    : []);
  const perKey = gridded || paired || !!opts.offset;
  const tipped = rows.some((r) => r.tipDeg);
  const poseHead = posed ? ['pose', 'poseX', 'poseY', 'poseZ', 'turnDeg', ...(tipped ? ['tipXDeg', 'tipZDeg'] : [])] : [];
  const poseCells = (r) => (posed ? [r.pose, fmt(r.poseMm?.[0], 2), fmt(r.poseMm?.[1], 2), fmt(r.poseMm?.[2], 2), fmt(r.turnDeg, 2),
    ...(tipped ? [fmt(r.tipDeg?.[0] ?? 0, 2), fmt(r.tipDeg?.[1] ?? 0, 2)] : [])] : []);
  const viewHead = [...poseHead, ...(gridded ? ['yaw', 'elevation'] : []), ...(paired ? ['pair'] : []),
    ...(perKey ? ['pxPerMm', 'overlapPx'] : [])];
  const viewCells = (r) => [...poseCells(r), ...(gridded ? [r.yaw, r.elevation] : []), ...(paired ? [r.pair ?? ''] : []),
    ...(perKey ? [fmt(r.pxPerMm, 3), fmt(r.overlapPx, 1)] : [])];
  const head = [...viewHead, 'gapMm', 'trueGapPx', 'measuredGapPx', 'errorPx', 'errorMm',
    `${opts.moving}OffsetPx`, `${opts.target}OffsetPx`, ...refitHead, ...trackHead, 'pairFound', 'spansBoth',
    `${opts.moving}Found`, `${opts.target}Found`, ...causes.map((c) => `inGap_${c}`), 'reason'];
  const body = rows.map((r) => [
    ...viewCells(r), r.gapMm, fmt(r.trueGapPx, 3), fmt(r.measuredGapPx, 3), fmt(r.errorPx, 3), fmt(r.errorMm, 3),
    fmt(r.movingOffsetPx, 3), fmt(r.targetOffsetPx, 3), ...refitCells(r), ...trackCells(r), r.pairFound, r.spansBoth, `${r.moving.found}/${r.moving.findable}`, `${r.target.found}/${r.target.findable}`,
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
      : paired ? `${Math.max(...rows.map((r) => r.pair ?? 0))} facing pairs`
        : opts.offset ? `${fmt(scales.get(viewKey(rows[0])), 3)} px per mm along the sweep` : `${fmt(scale, 3)} px per mm of gap`)
    + (opts.offset ? `, offset ${opts.offset.join(', ')} mm, swept along ${opts.axis.map((v) => fmt(v, 2)).join(', ')}` : ''));
  console.log(csv.join('\n'));
  if (gridded && !posed) {
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
