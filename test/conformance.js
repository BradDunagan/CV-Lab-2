'use strict';

/**
 * The conformance case (test/conformance/, written by scripts/conformance.js):
 * a real frame, the statements a frame goes through, and the hash each must
 * give. It exists for HOSTS -- rr's Playwright suite runs it in a browser
 * through rr's own build -- and this holds cv-lab itself to it: the native
 * addon and the module, on every CI runner, so a hash a host is asked to match
 * is one every platform here gives.
 *
 * Literal hashes, like test/determinism.js, and for its reason: the property
 * is "this value, everywhere". If one changes, an operation changed: bump its
 * version, run scripts/conformance.js again, and say why in the commit.
 *
 *   node test/conformance.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = path.join(__dirname, 'conformance');
let failures = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

console.log('cv-lab-2 conformance tests');

(async () => {
  const { createRegistry } = await import('../packages/vision/src/ops.js');
  const { Session } = await import('../packages/vision/src/session.js');
  const { decodePfm } = await import('../packages/vision/src/pfm.js');
  const { loadWasm } = await import('../packages/vision/src/wasm.js');
  const doc = JSON.parse(fs.readFileSync(path.join(DIR, 'case.json'), 'utf8'));
  const bytes = fs.readFileSync(path.join(DIR, 'frame.pfm'));
  const frame = decodePfm(bytes);

  /** Each statement's output on a backend, in order. */
  const run = async (backend) => {
    const session = new Session({ registry: createRegistry({ backend, readFrame: async () => frame }) });
    const out = [];
    for (const { statement } of doc.statements) out.push((await session.execute(statement)).output);
    session.reset();
    return out;
  };

  test('the frame is the one the hashes were taken on', () => {
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), doc.frame.sha256);
    assert.equal(frame.width, doc.frame.width);
    assert.equal(frame.height, doc.frame.height);
  });

  test('the case is not silently empty: every feature statement finds something', async () => {
    const out = await run(require('../native/index.js'));
    doc.statements.forEach(({ statement }, i) => {
      if (out[i].kind === 'features') assert.ok(out[i].count > 0, `${statement}: no features`);
    });
  });

  for (const [name, backend] of [
    ['the native addon', async () => require('../native/index.js')],
    ['the module', async () => loadWasm(fs.readFileSync(path.join(__dirname, '..', 'packages', 'vision', 'wasm', 'cvlab.wasm')))],
  ]) {
    test(`${name} gives every statement's hash`, async () => {
      const out = await run(await backend());
      const wrong = doc.statements.filter((s, i) => out[i].hash !== s.hash).map((s) => s.statement);
      assert.deepEqual(wrong, []);
    });
  }

  test('the case names the module it was taken with, and that is the committed one', async () => {
    const wasm = await loadWasm(fs.readFileSync(path.join(__dirname, '..', 'packages', 'vision', 'wasm', 'cvlab.wasm')));
    assert.equal(wasm.build, doc.module, 'the module was rebuilt: run scripts/conformance.js again');
  });

  for (const [name, fn] of queue) {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
  }
  console.log(failures === 0 ? '\nAll conformance tests passed.' : `\n${failures} failing.`);
  process.exit(failures === 0 ? 0 : 1);
})();
