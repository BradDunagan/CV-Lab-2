'use strict';

/**
 * Runs under plain `node`, no Electron required.
 *
 * Keeping the native layer testable outside Electron is worth the small
 * discipline it costs: it is far faster to iterate on, and it is what CI runs
 * to prove the addon compiled correctly on each platform.
 *
 *   npm run build:native && npm run test:native
 */

const assert = require('node:assert/strict');
const native = require('../native');

let failures = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((err) => {
      failures++;
      console.error(`  FAIL ${name}\n       ${err.message}`);
    });
}

async function main() {
  console.log(`cv-lab-2 native smoke test (node ${process.versions.node}, ${process.platform}/${process.arch})`);

  await test('invertSync inverts RGB and preserves alpha', () => {
    const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 0]);
    native.invertSync(px);
    assert.deepEqual([...px], [255, 255, 255, 255, 0, 0, 0, 0]);
  });

  await test('invert (async) resolves and mutates in place', async () => {
    const px = new Uint8ClampedArray([10, 20, 30, 128]);
    const result = await native.invert(px);
    assert.equal(result, undefined, 'invert resolves with undefined');
    assert.deepEqual([...px], [245, 235, 225, 128]);
  });

  await test('double invert is the identity', async () => {
    const px = new Uint8ClampedArray(4096);
    for (let i = 0; i < px.length; i++) px[i] = i % 256;
    const before = Uint8ClampedArray.from(px);
    await native.invert(px);
    await native.invert(px);
    assert.deepEqual([...px], [...before]);
  });

  await test('rejects a non-typed-array', () => {
    assert.throws(() => native.invertSync([0, 0, 0, 255]), /Uint8ClampedArray/);
  });

  await test('rejects a length that is not a multiple of 4', () => {
    assert.throws(() => native.invertSync(new Uint8ClampedArray(5)), /multiple of 4/);
  });

  await test('does not copy: C writes into the JS buffer', async () => {
    // If the addon were copying, the original view would be unchanged.
    const buffer = new ArrayBuffer(8);
    const view = new Uint8ClampedArray(buffer);
    view.set([1, 2, 3, 4, 5, 6, 7, 8]);
    await native.invert(view);
    assert.equal(new Uint8ClampedArray(buffer)[0], 254);
  });

  await test('async work actually runs off the JS thread', async () => {
    // 64 MP of RGBA. If this ran inline, the tick counter below would stay 0.
    const px = new Uint8ClampedArray(64 * 1024 * 1024);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const t0 = process.hrtime.bigint();
    await native.invert(px);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    clearInterval(timer);
    console.log(`       ${(px.length / 4 / 1e6).toFixed(0)} MP in ${ms.toFixed(1)} ms, ${ticks} event-loop ticks during the call`);
    assert.ok(ticks > 0, 'event loop was blocked -- work did not run on a background thread');
  });

  console.log(failures === 0 ? '\nAll native smoke tests passed.' : `\n${failures} failing.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
