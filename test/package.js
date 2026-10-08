'use strict';

/**
 * The vision package (packages/vision) as a host other than cv-lab will see
 * it -- rr in a browser, rr-desktop under Electron.
 *
 *   - It bundles for the browser: esbuild, platform=browser, fails on any
 *     Node built-in the package reaches, directly or not.
 *   - The bundle RUNS with nothing but what a browser has: a bare vm
 *     context -- no require, process, Buffer or fs -- given the module's
 *     bytes. There it runs test/determinism.js's pipeline, and every slot's
 *     hash must be the one the addon gives in this process.
 *   - Its type declarations are current, and a TypeScript consumer that
 *     uses them compiles (packages/vision/types/, `npm run build:types`).
 *
 *   node test/package.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'packages', 'vision');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const SCRIPT = `
P  = pattern(kind=ramp, width=64, height=64, channels=3)
L  = toSrgb(P)
Q  = toLinear(L)
G  = gray(Q)
A  = pattern(kind=checker, width=64, height=64, channels=1)
B  = gaussian(A, sigma=1.4)
Gx = sobel(B, axis=x)
Gy = sobel(B, axis=y)
M  = sobel(B, axis=mag)
N  = nms(M, Gx, Gy)
S  = segments(N, Gx, Gy, minPixels=3)
R  = merge(S)
F  = fit(R)
C  = corners(F)
FP = fitPairs(F, B)
stats(B)
`;

const hashesOf = (session) => Object.fromEntries(session.toJSON().entries
  .filter((e) => e.output?.hash).map((e) => [e.target ?? `#${e.n}`, e.output.hash]));

(async () => {
  console.log('cv-lab-2 vision package tests');
  let bundle;

  await test('the package bundles for a browser: no Node built-in anywhere in it', async () => {
    const esbuild = require('esbuild');
    const result = await esbuild.build({
      entryPoints: [path.join(PKG, 'src', 'index.js')],
      bundle: true, platform: 'browser', format: 'iife', globalName: 'vision',
      write: false, logLevel: 'silent', target: 'es2022',
    });
    bundle = result.outputFiles[0].text;
    assert.ok(bundle.length > 10000, 'the bundle should hold the library');
    // Word-bounded: `ArrayBuffer.isView` is the browser's, `Buffer.from` is Node's.
    for (const word of [/\brequire\(/, /\bprocess\./, /\bBuffer\./, /\b__dirname\b/]) {
      assert.ok(!word.test(bundle), `the bundle mentions ${word}`);
    }
  });

  await test('in a bare context, from the module\'s bytes, it gives the addon\'s hashes', async () => {
    assert.ok(bundle, 'needs the bundle');
    // What a browser worker has, and nothing of Node's.
    const context = vm.createContext({ TextEncoder, TextDecoder, URL, console });
    vm.runInContext(`${bundle}\nglobalThis.vision = vision;`, context);
    const { loadWasm, createRegistry, Session } = context.vision;
    assert.equal(typeof context.require, 'undefined');
    assert.equal(typeof context.process, 'undefined');

    const bytes = new Uint8Array(fs.readFileSync(path.join(PKG, 'wasm', 'cvlab.wasm')));
    const backend = await loadWasm(bytes);
    assert.equal(backend.backend, 'wasm');
    assert.match(backend.build, /^[0-9a-f]{64}$/);
    const browser = new Session({ registry: createRegistry({ backend }) });
    await browser.run(SCRIPT);

    const { createLabRegistry } = require('../src/lab-host');
    const { Session: NodeSession } = require('../packages/vision/src/session.js');
    const addon = new NodeSession({ registry: createLabRegistry() });
    await addon.run(SCRIPT);

    const got = hashesOf(browser), expected = hashesOf(addon);
    assert.ok(Object.keys(expected).length >= 15, 'the pipeline should hash every stage');
    assert.deepEqual(got, expected);
  });

  await test('without a backend it says what is missing, rather than reaching for an addon', async () => {
    const { createRegistry } = require('../packages/vision/src/ops.js');
    const { Session } = require('../packages/vision/src/session.js');
    const session = new Session({ registry: createRegistry() });
    await assert.rejects(session.run('A = pattern(kind=ramp, width=4, height=4)'), /no compute backend: pass createRegistry\(\{ backend \}\)/);
  });

  await test('the type declarations are current, and a TypeScript consumer compiles against them', () => {
    const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-types.js'), '--check'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
  });

  console.log(failures === 0 ? '\nAll vision package tests passed.' : `\n${failures} failing.`);
  process.exit(failures === 0 ? 0 : 1);
})();
