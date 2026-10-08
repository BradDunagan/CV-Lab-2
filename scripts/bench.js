#!/usr/bin/env node
'use strict';

/**
 * What one frame costs: the measuring pipeline, per frame, on each backend.
 *
 *   npm run bench -- generated/bench-512/*.pfm --carry results/<run>/carry-commands.json
 *   npm run bench -- <frames> --browsers chromium,firefox,webkit --playwright ../rr/node_modules
 *
 * The pipeline is pipelines/pairs.lab without the lines that score against
 * truth (explain, match) -- what a robot cell runs on every view of every
 * frame -- plus the frame's own carried trackPair commands (--carry, as
 * gap-sweep --carry writes them; --scale multiplies their pixel coordinates,
 * for frames rendered larger than the run they came from).
 *
 * Under Node it times the native addon and the WebAssembly module. With
 * --browsers it also runs the module in a Web Worker in each browser
 * Playwright drives, served from a local server here, as rr will run it.
 * Every backend must give the same output hashes, or the run fails: a fast
 * wrong answer is not a measurement.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const USAGE = `
npm run bench -- <frame.pfm | dir> ... [options]

  --reps <n>          timed repetitions per frame, after a warm-up (default 5)
  --script <file>     the pipeline (default pipelines/pairs.lab, less explain
                      and match)
  --carry <file>      carry-commands.json from gap-sweep --carry: each frame's
                      trackPair commands, by its name
  --scale <k>         multiply their pixel coordinates by k (default 1)
  --backends <list>   native,wasm under Node (default both)
  --browsers <list>   also chromium, firefox, webkit: the module in a Worker
  --playwright <dir>  a node_modules holding playwright (default: resolve it)
  --browser-exe <b>=<path>  launch browser b from this executable rather than
                      Playwright's own build; <path> "chrome" is the installed
                      Google Chrome. Repeatable
  --out <file>        everything measured, as JSON
`;

function parseArgs(argv) {
  const opts = { frames: [], reps: 5, script: 'pipelines/pairs.lab', carry: null, scale: 1,
    backends: ['native', 'wasm'], browsers: [], playwright: null, exes: {}, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`); return argv[++i]; };
    switch (a) {
      case '--reps': opts.reps = Number(next()); break;
      case '--script': opts.script = next(); break;
      case '--carry': opts.carry = next(); break;
      case '--scale': opts.scale = Number(next()); break;
      case '--backends': opts.backends = next().split(',').filter(Boolean); break;
      case '--browsers': opts.browsers = next().split(',').filter(Boolean); break;
      case '--playwright': opts.playwright = next(); break;
      case '--browser-exe': { const [b, ...p] = next().split('='); opts.exes[b] = p.join('='); break; }
      case '--out': opts.out = next(); break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
        opts.frames.push(a);
    }
  }
  if (!(Number.isInteger(opts.reps) && opts.reps > 0)) throw new Error('--reps needs a positive integer');
  if (!(opts.scale > 0)) throw new Error('--scale needs a positive number');
  return opts;
}

/** Frames named on the command line: files, or every .pfm in a directory. */
function frameFiles(list) {
  const files = list.flatMap((p) => (fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).filter((n) => n.endsWith('.pfm')).sort().map((n) => path.join(p, n)) : [p]));
  const bad = files.filter((f) => !f.endsWith('.pfm'));
  if (bad.length || files.length === 0) throw new Error(bad.length ? `not a .pfm frame: ${bad[0]}` : 'no frames');
  return files;
}

/** The pipeline's statements, less what scores against truth. */
function pipeline(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !/=\s*(explain|match)\(/.test(l));
}

/** A frame's carried commands, their pixel coordinates scaled. */
function carried(carry, name, scale) {
  const commands = carry?.[name] ?? [];
  return commands.map((c) => c.replace(/\b(x0|y0|x1|y1|towardX|towardY|guess)=(-?[\d.]+)/g,
    (_, k, v) => `${k}=${(Number(v) * scale).toFixed(6)}`));
}

const median = (v) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function nodeBackend(name, frames, script, reps) {
  const { benchFrames } = await import('./bench-core.mjs');
  const { createRegistry } = await import('../packages/vision/src/ops.js');
  const { decodePfm } = await import('../packages/vision/src/pfm.js');
  const decoded = new Map(frames.map((f) => [f.source, decodePfm(fs.readFileSync(f.file))]));
  const readFrame = async (source) => decoded.get(source);
  let backend;
  if (name === 'native') backend = require('../native/index.js');
  else if (name === 'wasm') {
    const { loadWasm } = await import('../packages/vision/src/wasm.js');
    backend = await loadWasm(fs.readFileSync(path.join(ROOT, 'packages/vision/wasm/cvlab.wasm')));
  } else throw new Error(`unknown backend ${name}`);
  const results = await benchFrames({ registry: createRegistry({ backend, readFrame }), frames, script, reps });
  return { name: `${name} (node ${process.versions.node})`, results };
}

/** A local server for the browsers: the page, the worker bundle, the module and the frames. */
async function serve(frames) {
  const esbuild = require('esbuild');
  const bundle = await esbuild.build({ entryPoints: [path.join(__dirname, 'bench-worker.mjs')], bundle: true,
    format: 'iife', platform: 'browser', write: false, logLevel: 'silent' });
  const files = new Map([
    ['/bench.html', ['text/html', '<!doctype html><meta charset="utf-8"><title>bench</title>']],
    ['/bench-worker.js', ['text/javascript', bundle.outputFiles[0].text]],
    ['/cvlab.wasm', ['application/wasm', fs.readFileSync(path.join(ROOT, 'packages/vision/wasm/cvlab.wasm'))]],
    ...frames.map((f) => [f.source, ['application/octet-stream', fs.readFileSync(f.file)]]),
  ]);
  const server = http.createServer((req, res) => {
    const hit = files.get(req.url);
    if (!hit) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': hit[0] });
    res.end(hit[1]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function browserBackends(names, frames, script, reps, playwrightDir, exes) {
  const playwright = require(playwrightDir ? require.resolve('playwright', { paths: [path.resolve(playwrightDir)] }) : 'playwright');
  const { server, base } = await serve(frames);
  const out = [];
  try {
    for (const name of names) {
      const exe = exes[name];
      const browser = await playwright[name].launch(!exe ? {} : exe === 'chrome' ? { channel: 'chrome' } : { executablePath: exe });
      try {
        const page = await browser.newPage();
        await page.goto(`${base}/bench.html`);
        const reply = await page.evaluate(({ frames, script, reps }) => new Promise((resolve) => {
          const worker = new Worker('/bench-worker.js');
          worker.onmessage = ({ data }) => resolve(data);
          worker.onerror = (e) => resolve({ ok: false, error: e.message });
          worker.postMessage({ wasm: '/cvlab.wasm', frames, script, reps });
        }), { frames: frames.map(({ source, commands }) => ({ source, commands })), script, reps });
        if (!reply.ok) throw new Error(`${name}: ${reply.error}`);
        out.push({ name: `${name} ${browser.version()} worker`, results: reply.results });
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.frames.length === 0) { console.log(USAGE); process.exit(opts.help ? 0 : 2); }
  const carry = opts.carry ? JSON.parse(fs.readFileSync(opts.carry, 'utf8')) : null;
  const script = pipeline(path.resolve(ROOT, opts.script));
  const frames = frameFiles(opts.frames).map((file, k) => {
    const name = path.basename(file, '.pfm');
    return { file, name, source: `/frames/${k}-${name}.pfm`, commands: carried(carry, name, opts.scale) };
  });
  const runs = [];
  for (const b of opts.backends) runs.push(await nodeBackend(b, frames, script, opts.reps));
  if (opts.browsers.length) runs.push(...await browserBackends(opts.browsers, frames, script, opts.reps, opts.playwright, opts.exes));

  // The same answer everywhere, or the run says where it is not. A backend
  // whose hashes differ is still timed -- the difference is a finding, not a
  // reason to lose the timing -- but the run exits non-zero.
  const first = runs[0];
  const statements = (k) => [`A = frame(...)`, ...script, ...frames[k].commands];
  let differ = 0;
  for (const run of runs.slice(1)) {
    run.results.forEach((r, k) => {
      const bad = r.hashes.map((h, j) => (h === first.results[k].hashes[j] ? null : statements(k)[j])).filter(Boolean);
      if (bad.length) {
        differ++;
        run.differs = true;
        console.log(`${run.name} differs from ${first.name} on ${frames[k].name}: ${bad.join('; ')}`);
      }
    });
  }

  const { decodePfm } = await import('../packages/vision/src/pfm.js');
  const sizes = frames.map((f) => { const d = decodePfm(fs.readFileSync(f.file)); return `${d.width}x${d.height}`; });
  console.log(`${frames.length} frame(s), ${[...new Set(sizes)].join(', ')}; ${script.length + 1} statements + ${frames.map((f) => f.commands.length).join('/')} carried; `
    + `median of ${opts.reps} after a warm-up; ${differ ? 'HASHES DIFFER, above' : 'the same hashes on every backend'}\n`);
  const ref = runs.find((r) => r.name.startsWith('native')) ?? first;
  const perFrame = (run) => median(run.results.map((r) => median(r.totals)));
  console.log(`${'backend'.padEnd(34)} ${'ms/frame'.padStart(9)} ${'x native'.padStart(9)}   slowest steps (ms)`);
  for (const run of runs) {
    const ms = perFrame(run);
    const ops = {};
    for (const r of run.results) for (const [op, v] of Object.entries(r.ops)) (ops[op] ??= []).push(median(v));
    const top = Object.entries(ops).map(([op, v]) => [op, median(v)]).sort((a, b) => b[1] - a[1]).slice(0, 4);
    console.log(`${(run.name + (run.differs ? ' *' : '')).padEnd(34)} ${ms.toFixed(1).padStart(9)} ${(ms / perFrame(ref)).toFixed(2).padStart(9)}   `
      + top.map(([op, v]) => `${op} ${v.toFixed(1)}`).join(', '));
  }
  if (opts.out) {
    fs.writeFileSync(opts.out, `${JSON.stringify({ frames: frames.map((f, k) => ({ file: f.file, size: sizes[k], commands: f.commands })),
      script, reps: opts.reps, platform: `${process.platform}/${process.arch}`, runs }, null, 2)}\n`);
  }
  if (differ) process.exitCode = 1;
}

main().catch((err) => { console.error(err.message); process.exit(1); });
