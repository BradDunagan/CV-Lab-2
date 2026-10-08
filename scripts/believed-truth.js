#!/usr/bin/env node
/**
 * The edges the system would PREDICT, not the ones that are there: a
 * generated run's shots again, with the moving part where the robot
 * believes it is -- its true pose moved by a seeded error -- rendered for
 * their ground truth alone. `gap-sweep --identify <dir>` then says which
 * detected edge is which part, and where along a pair the gap is read, from
 * these, and keeps the real truth for scoring only.
 *
 * Why: in rr there is no renderer's truth to ask. There is the parts' own
 * geometry and where the system believes they are, which is exactly what
 * pt-lab's edge extraction at a believed pose computes. What it costs is the
 * question (design-lab-model.md §5, "A thirty-eighth").
 *
 *   npm run believed-truth -- generated/<run> generated/<run>-<tag> --mm 0.5 --deg 0.3
 *
 *   --mm <s>      sd of the position error, per axis, in mm          (0.5)
 *   --deg <s>     sd of the turn error about the vertical, degrees   (0.3)
 *   --seed <n>                                                       (1)
 *   --scene <s>   the scene the run was rendered from     (saved:stack-2)
 *   --moving <k>  the part that moves                          (Cube2)
 *   --errors <f>  each pose's error given, not drawn: {"pose 1": {"mm": [x,y,z],
 *                 "deg": t}, ...} -- a first solve's estimate less the truth,
 *                 for the second identification a loop makes
 *
 * One error per pose, not per shot: every view of a pose shares the belief,
 * as the views of one robot do. The errors are written into shots.json
 * (`believedErrorMm`, `believedErrorDeg`). Needs a GPU; one sample a pixel,
 * since only the edges are kept.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const [src, dst, ...rest] = process.argv.slice(2);
const opts = { mm: 0.5, deg: 0.3, seed: 1, scene: 'saved:stack-2', moving: 'Cube2', errors: null };
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i].replace(/^--/, '');
  if (!(k in opts)) { console.error(`unknown option ${rest[i]}`); process.exit(2); }
  opts[k] = ['scene', 'moving', 'errors'].includes(k) ? rest[i + 1] : Number(rest[i + 1]);
}
if (!src || !dst) { console.error('usage: npm run believed-truth -- <generated/run> <generated/new> [--mm s] [--deg s] [--seed n]'); process.exit(2); }
const shotsFile = path.join(src, 'shots.json');
if (!fs.existsSync(shotsFile)) { console.error(`${src} is not a generated run: no shots.json`); process.exit(2); }
if (fs.existsSync(path.join(dst, 'shots.json'))) { console.error(`${dst} already holds a run`); process.exit(2); }

let seed = opts.seed >>> 0;
const uniform = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());

const { resolveScene } = require('../src/generate/driver');
const scene = resolveScene(opts.scene)?.sceneData;
const base = scene?.objects.find((o) => o.key === opts.moving)?.transform;
if (!base) { console.error(`${opts.scene} has no ${opts.moving}`); process.exit(2); }

// One error per pose -- a sweep's step, or a pose's number -- drawn in the
// order the poses first appear, so a run's errors depend on its seed alone.
const shots = JSON.parse(fs.readFileSync(shotsFile, 'utf8'));
const errors = new Map();
const given = opts.errors ? JSON.parse(fs.readFileSync(opts.errors, 'utf8')) : null;
const errorOf = (s) => {
  const key = s.pose !== undefined ? `pose ${s.pose}` : `gap ${s.gapMm}`;
  if (given && !given[key]) { console.error(`${opts.errors} has no error for ${key}`); process.exit(2); }
  if (!errors.has(key)) errors.set(key, given ? given[key] : { mm: [gauss(), gauss(), gauss()].map((v) => v * opts.mm), deg: gauss() * opts.deg });
  return errors.get(key);
};
const believed = shots.map((s) => {
  const e = errorOf(s);
  const t = s.transforms[opts.moving];
  const rotation = t.rotation ?? base.rotation ?? [0, 0, 0];
  return {
    ...s,
    believedErrorMm: e.mm.map((v) => Number(v.toFixed(4))),
    believedErrorDeg: Number(e.deg.toFixed(4)),
    transforms: { ...s.transforms, [opts.moving]: {
      position: t.position.map((p, k) => p + e.mm[k] / 1000),
      rotation: [rotation[0], rotation[1] + e.deg, rotation[2]],
    } },
  };
});
fs.mkdirSync(dst, { recursive: true });
fs.writeFileSync(path.join(dst, 'shots.json'), JSON.stringify(believed, null, 2));
fs.writeFileSync(path.join(dst, 'believed.json'), `${JSON.stringify({ from: src, ...opts, poses: Object.fromEntries(errors) }, null, 2)}\n`);

const size = JSON.parse(fs.readFileSync(path.join(src, shots[0].name.replace(/\.png$/, '.gt.json')), 'utf8')).size;
const electron = require('electron');
const r = spawnSync(electron, [path.join(ROOT, 'scripts', 'generate-cli.js'), '--out', dst, '--scene', opts.scene,
  '--shots', path.join(dst, 'shots.json'), '--size', String(size), '--samples', '1', '--truth', '--tone-mapping', 'linear'],
{ cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`${dst}: ${shots.length} shots, ${errors.size} believed poses (${opts.errors ? `errors from ${opts.errors}` : `sd ${opts.mm} mm, ${opts.deg} deg`})`);
