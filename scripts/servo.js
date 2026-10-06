#!/usr/bin/env node
/**
 * A closed loop: the estimate drives the motion.
 *
 * gap-sweep and solve-position measure a pose the part was PUT at. A robot
 * does the opposite: it reads where the part is, commands a correction, and
 * reads again, down to contact. Each step here renders the part where the
 * robot really left it -- the commanded move, executed with a scale error and
 * noise of its own -- runs the lab on it (gap-sweep, one pose, every view),
 * and solves the pose against a saved calibration with the last estimate,
 * moved by the commanded move, as a prior. The robot never sees the truth;
 * this script keeps it only to score the loop.
 *
 *   npm run servo -- --name <run> --calibration <file> --start <x,y,z,turn> [options]
 *
 * Writes results/servo/<run>/servo.json; each step is a gap-sweep run named
 * servo/<run>/step-<k>, so its renders and logs are where any other run's are.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { solvePosition, solveHinged } = require('../src/lab/position');

const ROOT = path.join(__dirname, '..');

const USAGE = `
CV-Lab servo -- estimate, correct, render, repeat, down to contact

  npm run servo -- --name <run> --calibration <file> --start <x,y,z,turn> [options]

  --name <run>          the loop's name: steps are gap-sweep runs
                        servo/<run>/step-<k>                     (required)
  --calibration <file>  solve-position --save-calibration output (required)
  --start <x,y,z,turn>  where the part really is to begin with: mm from
                        contact, degrees about the vertical      (required)
  --start-sigma <mm>    how well the robot knows the start before anything is
                        seen; the believed start is the true one off by this
                        (seeded); degrees for the turn           (default 1)
  --scene, --moving, --target, --yaw, --elevation, --script
                        passed to gap-sweep     (default saved:stack-2, Cube2,
                        Cube, 35,60, 20,50, pipelines/pairs.lab)
  --carry-from <dir>    passed to gap-sweep, repeatable: the runs the still
                        edges are held from
  --max-angle <deg>     passed to gap-sweep: how far from parallel a pair
                        may be and still give a reading. A part turned 5
                        degrees is past gap-sweep's own default  (default 12)
  --hover <mm>          the height (y) the part is aligned at before it
                        descends                                 (default 4)
  --descend <mm>        the most y comes down in one step        (default 1.5)
  --align <mm>          the estimated x/z error (and degrees of turn, the
                        same number) under which it may descend  (default 0.15)
  --final <mm>          below this estimated height the next move goes to
                        contact                                  (default 1)
  --lateral-floor <mm>  below this estimated height, move in y only: x, z
                        and the turn are left where the last estimate above
                        it put them. Narrow gaps read x worst; 0 corrects
                        everywhere                               (default 0)
  --max-steps <n>       give up after this many renders          (default 12)
  --scale-error <f>     each axis's move is off by a fixed factor drawn with
                        this sd: a robot's calibration          (default 0.02)
  --move-noise <mm>     and by this much at random each move, per axis;
                        degrees for the turn                     (default 0.02)
  --reading-sigma <px>  a reading's error against the prior     (default 0.1)
  --motion-sigma <mm>   the prior's growth per move, per axis   (default 0.1)
  --seed <n>            for the robot's errors                   (default 1)
  --dry-run             no renders: each reading is the calibration's own
                        model of the true pose, plus --dry-noise px of noise.
                        The loop's logic, checked on its own
`.trim();

function parseArgs(argv) {
  const list = (s, what) => {
    const v = String(s).split(',').map(Number);
    if (v.some((x) => !Number.isFinite(x))) throw new Error(`${what}: "${s}" is not a list of numbers`);
    return v;
  };
  const opts = { name: null, calibration: null, start: null, startSigma: 1, scene: 'saved:stack-2', moving: 'Cube2',
    target: 'Cube', yaw: '35,60', elevation: '20,50', script: 'pipelines/pairs.lab', carryFrom: [], maxAngle: 12, hover: 4,
    descend: 1.5, align: 0.15, final: 1, lateralFloor: 0, maxSteps: 12, scaleError: 0.02, moveNoise: 0.02, readingSigma: 0.1,
    motionSigma: 0.1, seed: 1, dryRun: false, dryNoise: 0.05 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => list(argv[++i], a)[0];
    switch (a) {
      case '--name': opts.name = argv[++i]; break;
      case '--calibration': opts.calibration = argv[++i]; break;
      case '--start': opts.start = list(argv[++i], a); break;
      case '--start-sigma': opts.startSigma = num(); break;
      case '--scene': opts.scene = argv[++i]; break;
      case '--moving': opts.moving = argv[++i]; break;
      case '--target': opts.target = argv[++i]; break;
      case '--yaw': opts.yaw = argv[++i]; break;
      case '--elevation': opts.elevation = argv[++i]; break;
      case '--script': opts.script = argv[++i]; break;
      case '--carry-from': opts.carryFrom.push(argv[++i]); break;
      case '--max-angle': opts.maxAngle = num(); break;
      case '--hover': opts.hover = num(); break;
      case '--descend': opts.descend = num(); break;
      case '--align': opts.align = num(); break;
      case '--final': opts.final = num(); break;
      case '--lateral-floor': opts.lateralFloor = num(); break;
      case '--max-steps': opts.maxSteps = num(); break;
      case '--scale-error': opts.scaleError = num(); break;
      case '--move-noise': opts.moveNoise = num(); break;
      case '--reading-sigma': opts.readingSigma = num(); break;
      case '--motion-sigma': opts.motionSigma = num(); break;
      case '--seed': opts.seed = num(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--dry-noise': opts.dryNoise = num(); break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (opts.start && opts.start.length !== 4) throw new Error('--start is x,y,z,turn');
  return opts;
}

/** Seeded normal deviates (the same generator solve-position uses). */
function gaussians(seed) {
  let x = seed >>> 0;
  const u = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x + 0.5) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

const fmt = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(d));
const vec = (v, d = 2) => v.map((x) => fmt(x, d).padStart(d + 4)).join(' ');
const viewOf = (r) => `yaw ${r.yaw}, elev ${r.elevation}`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[(s.length - 1) >> 1] : null; };

/**
 * Each view's pairs by the angle they run at in the image, from the sweeps
 * the calibration was made from. gap-sweep numbers a run's pairs by angle
 * within that run, so a step that lost one pair would call the other "1";
 * matching on the angle keeps a reading the reading it was calibrated as.
 */
function pairAngles(cal) {
  const angles = new Map();
  for (const dir of Object.values(cal.sweeps)) {
    const run = JSON.parse(fs.readFileSync(path.resolve(ROOT, dir, 'gap-sweep.json'), 'utf8'));
    for (const r of run.rows) {
      if (r.pair == null || r.pairAngle == null) continue;
      const k = `${viewOf(r)} / pair ${r.pair}`;
      if (!angles.has(k)) angles.set(k, []);
      angles.get(k).push(r.pairAngle);
    }
  }
  return new Map([...angles].map(([k, a]) => [k, median(a)]));
}

function pairOf(r, angles) {
  let best = null;
  for (const [k, a] of angles) {
    if (!k.startsWith(`${viewOf(r)} / `)) continue;
    const d = Math.abs(((r.pairAngle - a + 90) % 180 + 180) % 180 - 90);
    if (d <= 10 && (!best || d < best.d)) best = { d, pair: Number(k.split(' pair ')[1]) };
  }
  return best?.pair ?? null;
}

/** One reading per point of each pair, the carried mode's: tracked, else refit, else detected. */
function readingsOf(rows, angles) {
  const out = new Map();
  for (const r of rows) {
    if (r.pairAngle == null) continue;
    const pair = pairOf(r, angles);
    if (pair === null) continue;
    const pick = (truth, tracked, refit, detected, sigmaT, sigmaR) => (tracked != null ? [tracked, sigmaT]
      : refit != null ? [refit, sigmaR] : [detected, null]);
    const points = {
      mid: pick(r.trueGapPx, r.tracked?.gapPx, r.refit?.gapPx, r.pairFound ? r.measuredGapPx : null, r.tracked?.gapSigma, r.refit?.gapSigma),
      'end 1': pick(r.endsTruePx?.[0], r.tracked?.endsPx?.[0], r.refit?.endsPx?.[0], r.endsDetectedPx?.[0], r.tracked?.gapSigma, r.refit?.gapSigma),
      'end 2': pick(r.endsTruePx?.[1], r.tracked?.endsPx?.[1], r.refit?.endsPx?.[1], r.endsDetectedPx?.[1], r.tracked?.gapSigma, r.refit?.gapSigma),
    };
    for (const [p, v] of Object.entries(points)) {
      if (v[0] != null && Number.isFinite(v[0])) out.set(`${viewOf(r)} / pair ${pair} / ${p}`, v);
    }
    // A track that could not tell a strip from one edge: both readings, for
    // the prior to choose between (trackPair's `hypotheses`).
    if (r.tracked?.hypotheses?.length && r.tracked.gapPx == null && r.refit?.gapPx == null) {
      const at = { mid: (h) => h.gapPx, 'end 1': (h) => h.endsPx?.[0], 'end 2': (h) => h.endsPx?.[1] };
      for (const [p, f] of Object.entries(at)) {
        const key = `${viewOf(r)} / pair ${pair} / ${p}`;
        const hs = r.tracked.hypotheses.map(f).filter((v) => v != null && Number.isFinite(v));
        if (!out.has(key) && hs.length === 2) out.set(key, [null, r.tracked.hypotheses[0].gapSigma, hs]);
      }
    }
  }
  return out;
}

function gapSweep(opts, stepName, pose) {
  const args = [path.join(ROOT, 'scripts/gap-sweep.js'), '--name', stepName, '--scene', opts.scene,
    '--moving', opts.moving, '--target', opts.target, '--poses', pose.map((v) => +v.toFixed(4)).join(','),
    '--yaw', opts.yaw, '--elevation', opts.elevation, '--script', opts.script, '--carry', '--max-angle', String(opts.maxAngle),
    ...opts.carryFrom.flatMap((d) => ['--carry-from', d])];
  const gen = path.join(ROOT, 'generated', stepName);
  if (fs.existsSync(path.join(gen, 'shots.json'))) args.push('--skip-render');
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gap-sweep ${stepName} failed`);
  const scriptName = path.basename(opts.script).replace(/\.lab$/, '');
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'results', stepName, scriptName, 'gap-sweep.json'), 'utf8')).rows;
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(`${err.message}\n\n${USAGE}`); process.exit(2); }
  if (opts.help || !opts.name || !opts.calibration || !opts.start) { console.log(USAGE); process.exit(opts.help ? 0 : 2); }

  const cal = JSON.parse(fs.readFileSync(path.resolve(ROOT, opts.calibration), 'utf8'));
  if (cal.unknowns.join() !== 'x,y,z,turn') throw new Error('the calibration must solve x, y, z and the turn');
  const reference = [...cal.reference, 0];
  const angles = pairAngles(cal);
  const used = cal.calibrated;
  const g = gaussians(opts.seed);

  // The robot: a fixed scale error per axis, and noise per move.
  const scale = [0, 1, 2, 3].map(() => 1 + g() * opts.scaleError);
  const execute = (move) => move.map((m, a) => m * scale[a] + g() * opts.moveNoise);
  const goal = [0, 0, 0, 0];

  let truth = opts.start.slice();
  // What the robot believes before it has seen anything.
  let believed = truth.map((v) => v + g() * opts.startSigma);
  let state = null;           // the last solve: d (from the reference) and covariance
  let lastMove = null;
  const motion = [0, 1, 2, 3].map(() => opts.motionSigma ** 2);
  const weightOf = (sigma) => {
    const rel = sigma > 0 && cal.medianSigma ? sigma / cal.medianSigma : 1;
    return 1 / (opts.readingSigma * rel) ** 2;
  };

  const steps = [];
  console.log(`servo ${opts.name}: start ${vec(truth)} (true), believed ${vec(believed)}; robot scale ${scale.map((s) => fmt(s, 3)).join(' ')}`);
  console.log(`${'step'.padEnd(5)} ${'true pose x y z turn'.padEnd(29)} ${'estimate'.padEnd(29)} ${'error'.padEnd(29)} reads  command`);
  for (let k = 0; k < opts.maxSteps; k++) {
    const stepName = `servo/${opts.name}/step-${String(k).padStart(2, '0')}`;
    const reads = opts.dryRun
      ? new Map(used.map((p) => [p.key, [p.reference + p.jacobian.reduce((acc, j, a) => acc + j * (truth[a] - reference[a])
        + (p.hinge?.[a] ?? 0) * Math.min(truth[a] - reference[a], 0), 0) + g() * opts.dryNoise, null]]))
      : readingsOf(gapSweep(opts, stepName, truth), angles);
    const obs = used.map((p) => {
      const v = reads.get(p.key);
      return { jacobian: p.jacobian, hinge: p.hinge, reference: p.reference, measured: v ? v[0] : null, weight: weightOf(v?.[1]) };
    });
    const n = () => obs.filter((o) => Number.isFinite(o.measured)).length;
    // The prior: the last estimate moved by the move commanded since, or the
    // believed start, in displacement from the reference.
    const prior = state
      ? { d: state.d.map((v, a) => v + lastMove[a]), covariance: state.covariance.map((row, a) => row.map((x, b) => x + (a === b ? motion[a] : 0))) }
      : { d: believed.map((v, a) => v - reference[a]), covariance: [0, 1, 2, 3].map((a) => [0, 1, 2, 3].map((b) => (a === b ? opts.startSigma ** 2 : 0))) };
    /*
     * A reading given as two hypotheses is taken where the prior predicts one
     * of them: the prediction (with its own uncertainty, through the
     * Jacobian, and the reading's) must be nearer one by three sigmas.
     */
    let resolved = 0, unresolved = 0;
    for (const [i, p] of used.entries()) {
      const v = reads.get(p.key);
      if (!v?.[2]) continue;
      const model = (d) => p.reference + p.jacobian.reduce((acc, j, a) => acc + j * d[a] + (p.hinge?.[a] ?? 0) * Math.min(d[a], 0), 0);
      const predicted = model(prior.d);
      const jp = p.jacobian.map((_, a) => prior.covariance[a].reduce((acc, c, b) => acc + c * p.jacobian[b], 0));
      const sigma = Math.sqrt(p.jacobian.reduce((acc, j, a) => acc + j * jp[a], 0) + opts.readingSigma ** 2);
      const [near, far] = [...v[2]].sort((x, y) => Math.abs(x - predicted) - Math.abs(y - predicted));
      if (Math.abs(far - predicted) - Math.abs(near - predicted) >= 3 * sigma) { obs[i].measured = near; resolved++; } else unresolved++;
    }
    const s = solveHinged(obs, { prior });
    const alone = solveHinged(obs.map((o) => ({ ...o, weight: 1 })));
    if (!s.determined) throw new Error(`step ${k}: ${s.reason}`);
    state = s;
    const estimate = s.d.map((v, a) => v + reference[a]);
    const error = estimate.map((v, a) => v - truth[a]);

    /*
     * The policy, on the estimate only. Align x, z and the turn at the hover
     * height; descend once they are within --align, at most --descend a step,
     * correcting the alignment on the way; from under --final, go to contact.
     */
    const low = estimate[1] < opts.lateralFloor;
    const lateral = low ? [0, 0, 0] : [goal[0] - estimate[0], goal[2] - estimate[2], goal[3] - estimate[3]];
    const aligned = low || lateral.every((v) => Math.abs(v) <= opts.align);
    let targetY;
    if (estimate[1] > opts.hover + opts.descend) targetY = opts.hover;
    else if (!aligned) targetY = estimate[1];
    else if (estimate[1] - opts.descend > opts.final) targetY = estimate[1] - opts.descend;
    else targetY = goal[1];
    const command = [lateral[0], targetY - estimate[1], lateral[1], lateral[2]];
    const done = targetY === goal[1];
    const entry = { step: k, run: stepName, truth: truth.slice(), estimate, error, sigma: s.sigma, readings: n(), hypotheses: { resolved, unresolved },
      alone: alone.determined ? { estimate: alone.d.map((v, a) => v + reference[a]), error: alone.d.map((v, a) => v + reference[a] - truth[a]) } : null,
      command, aligned };
    steps.push(entry);
    console.log(`${String(k).padEnd(5)} ${vec(truth)}  ${vec(estimate)}  ${vec(error)}  ${String(n()).padStart(4)}${resolved + unresolved ? ` (${resolved}/${resolved + unresolved} of two)` : ''}   ${vec(command)}${done ? '   -> contact' : ''}`);

    const moved = execute(command);
    truth = truth.map((v, a) => v + moved[a]);
    lastMove = command;
    if (done) break;
  }
  // Where it ended: the last move's result, which nothing measured.
  const final = { truth, error: truth.map((v, a) => v - goal[a]) };
  console.log(`\nfinal pose ${vec(truth)}: off by ${vec(final.error)} (x y z mm, turn deg) after ${steps.length} renders`);
  if (truth[1] < -1e-6) console.log('  y < 0: the robot pushed past contact by that much; a real one would be stopped by it');

  const out = path.join(ROOT, 'results', 'servo', opts.name);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'servo.json'), `${JSON.stringify({ options: opts, robotScale: scale, steps, final }, null, 2)}\n`);
  console.log(path.relative(ROOT, path.join(out, 'servo.json')));
}

try { main(); } catch (err) { console.error(err.message); process.exit(1); }
