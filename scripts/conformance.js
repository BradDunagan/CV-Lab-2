#!/usr/bin/env node
/**
 * The package's conformance case: one real frame, the statements a frame
 * goes through, and the hash each one gives, for a HOST to check that it runs
 * the package as cv-lab does. rr's Playwright suite runs it in a browser
 * through rr's own build; `test/conformance.js` holds the native addon and the
 * module under Node to the same hashes on every CI runner.
 *
 * The frame is a crop of a bench frame (`npm run bench`), around the gap
 * between the stack's two cubes, so it stays small enough to commit: the
 * pipeline (pipelines/pairs.lab less what scores against truth) and the
 * frame's carried trackPair commands, their coordinates moved by the crop.
 *
 *   node scripts/conformance.js <frame.pfm> --carry <carry-commands.json> --name <shot> --crop x,y,w,h
 *
 * Writes test/conformance/: frame.pfm and case.json (where the frame came
 * from, the statements, the native addon's hash for each). Refuses to write
 * if the module under Node does not give the same hashes.
 *
 * With --scene and --shots, case.json also says how the frame was rendered --
 * the scene file, the shot, the size, the tone mapping (from the frame's
 * .gt.json) and the live view's sample cap -- so a host can render the same
 * shot through its own copy of pt-lab and compare what the statements read
 * (rr's tests/analysis-camera.spec.ts). A render is not bit-reproducible, so
 * that comparison is to within render noise, never by hash.
 *
 *   ... --scene scenes/stack-2.json --shots generated/<run>/shots.json [--samples 96]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'conformance');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function args(argv) {
  const o = { frame: null, carry: null, name: null, crop: null, script: 'pipelines/pairs.lab', scene: null, shots: null, samples: 96 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--carry') o.carry = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--crop') o.crop = argv[++i].split(',').map(Number);
    else if (a === '--script') o.script = argv[++i];
    else if (a === '--scene') o.scene = argv[++i];
    else if (a === '--shots') o.shots = argv[++i];
    else if (a === '--samples') o.samples = Number(argv[++i]);
    else if (!a.startsWith('--') && !o.frame) o.frame = a;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.frame || !o.carry || !o.name || o.crop?.length !== 4 || !o.crop.every(Number.isInteger)) {
    throw new Error('usage: conformance.js <frame.pfm> --carry <file> --name <shot> --crop x,y,w,h');
  }
  if (!o.scene !== !o.shots) throw new Error('--scene and --shots go together');
  return o;
}

/** How the frame was rendered: enough for a host to render the same shot again. */
function renderOf(o, size) {
  if (!o.scene) return undefined;
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  const shot = JSON.parse(fs.readFileSync(o.shots, 'utf8')).find((s) => s.name === `${o.name}.png`);
  if (!shot) throw new Error(`${o.shots} has no shot ${o.name}.png`);
  const gt = JSON.parse(fs.readFileSync(o.frame.replace(/\.pfm$/, '.gt.json'), 'utf8'));
  if (!gt.toneMapping) throw new Error(`${o.name}.gt.json records no tone mapping`);
  const { camera, target, intensity, transforms } = shot;
  return { scene: rel(o.scene), shots: rel(o.shots), size, toneMapping: gt.toneMapping, samples: o.samples,
    shot: { name: shot.name, camera, target, intensity, transforms } };
}

/** The pipeline's statements, less what scores against truth: as `npm run bench` runs it. */
function pipeline(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !/=\s*(explain|match)\(/.test(l));
}

/** A carried command moved into the crop's coordinates. */
function shifted(command, [cx, cy]) {
  return command.replace(/\b(x0|x1|towardX|y0|y1|towardY)=(-?[\d.]+)/g,
    (_, k, v) => `${k}=${(Number(v) - (k.startsWith('x') || k === 'towardX' ? cx : cy)).toFixed(6)}`);
}

/** Run the statements on one backend; the log's output hashes, in order. */
async function hashesOn(backend, frame, statements) {
  const { createRegistry } = await import('../packages/vision/src/ops.js');
  const { Session } = await import('../packages/vision/src/session.js');
  const session = new Session({ registry: createRegistry({ backend, readFrame: async () => frame }) });
  for (const s of statements) await session.execute(s);
  const hashes = session.toJSON().entries.map((e) => e.output.hash);
  session.reset();
  return hashes;
}

async function main() {
  const o = args(process.argv.slice(2));
  const { decodePfm, encodePfm } = await import('../packages/vision/src/pfm.js');
  const { loadWasm } = await import('../packages/vision/src/wasm.js');
  const sourceBytes = fs.readFileSync(o.frame);
  const whole = decodePfm(sourceBytes);
  const [cx, cy, w, h] = o.crop;
  if (cx < 0 || cy < 0 || cx + w > whole.width || cy + h > whole.height) throw new Error(`crop ${o.crop} is outside ${whole.width}x${whole.height}`);
  const c = whole.channels;
  const data = new Float32Array(w * h * c);
  for (let y = 0; y < h; y++) data.set(whole.data.subarray(((cy + y) * whole.width + cx) * c, ((cy + y) * whole.width + cx + w) * c), y * w * c);
  const frame = { width: w, height: h, channels: c, data };
  const bytes = encodePfm(frame);

  const carry = JSON.parse(fs.readFileSync(o.carry, 'utf8'))[o.name];
  if (!carry) throw new Error(`${o.carry} has nothing for ${o.name}`);
  const statements = ['A = frame("frame.pfm")', ...pipeline(o.script), ...carry.map((s) => shifted(s, [cx, cy]))];

  const native = await hashesOn(require('../native/index.js'), frame, statements);
  const wasmBackend = await loadWasm(fs.readFileSync(path.join(ROOT, 'packages/vision/wasm/cvlab.wasm')));
  const wasm = await hashesOn(wasmBackend, frame, statements);
  const differ = statements.filter((_, i) => native[i] !== wasm[i]);
  if (differ.length) throw new Error(`the module differs from the addon on: ${differ.join('; ')}`);

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'frame.pfm'), bytes);
  const doc = {
    about: 'The package run as cv-lab runs it: each statement and the hash it must give. scripts/conformance.js wrote it.',
    frame: { file: 'frame.pfm', sha256: sha(bytes), width: w, height: h,
      from: { file: path.relative(ROOT, o.frame).split(path.sep).join('/'), sha256: sha(sourceBytes), crop: o.crop } },
    carry: { file: path.relative(ROOT, o.carry).split(path.sep).join('/'), shot: o.name },
    script: o.script,
    render: renderOf(o, whole.width),
    module: wasmBackend.build,
    statements: statements.map((statement, i) => ({ statement, hash: native[i] })),
  };
  fs.writeFileSync(path.join(OUT, 'case.json'), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`test/conformance: ${w}x${h} frame (${(bytes.length / 1024).toFixed(0)} KB), ${statements.length} statements; ` +
    'the addon and the module agree on every hash');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
