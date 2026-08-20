'use strict';

/**
 * Buffer type tests — design-lab-model.md §1–2.
 *
 *   npm run build:native && node test/buffer.js
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
  const runtime = process.versions.electron
    ? `electron ${process.versions.electron}`
    : `node ${process.versions.node}`;
  console.log(`cv-lab-2 buffer tests (${runtime}, ${process.platform}/${process.arch})`);

  await test('creates an f32 buffer and reports its shape', () => {
    const buf = native.createBuffer({ width: 4, height: 3, channels: 1, dtype: 'f32', space: 'linear' });
    const info = native.bufferInfo(buf);
    assert.deepEqual(info, {
      width: 4, height: 3, channels: 1, dtype: 'f32', space: 'linear',
      bytes: 4 * 3 * 1 * 4, elements: 12, live: true,
    });
  });

  await test('defaults are f32 / none / 1 channel', () => {
    const info = native.bufferInfo(native.createBuffer({ width: 2, height: 2 }));
    assert.equal(info.dtype, 'f32');
    assert.equal(info.space, 'none');
    assert.equal(info.channels, 1);
  });

  await test('i32 buffers size correctly', () => {
    const info = native.bufferInfo(native.createBuffer({ width: 10, height: 10, dtype: 'i32' }));
    assert.equal(info.bytes, 400);
    assert.equal(info.dtype, 'i32');
  });

  await test('memory is zero-initialised', () => {
    const buf = native.createBuffer({ width: 8, height: 8, channels: 3 });
    const values = native.bufferRead(buf);
    assert.equal(values.length, 192);
    assert.ok(values.every((v) => v === 0), 'expected all zeros');
  });

  await test('write then read round-trips', () => {
    const buf = native.createBuffer({ width: 4, height: 1, channels: 1 });
    native.bufferWrite(buf, Float32Array.from([1.5, -2.5, 0, 42]));
    assert.deepEqual([...native.bufferRead(buf)], [1.5, -2.5, 0, 42]);
  });

  await test('bufferRead returns a copy, not an alias', () => {
    // Stated explicitly because the opposite would be a reasonable assumption.
    const buf = native.createBuffer({ width: 4, height: 1 });
    const a = native.bufferRead(buf);
    a[0] = 99;
    assert.equal(native.bufferRead(buf)[0], 0, 'writing the copy changed the buffer');
  });

  await test('bufferWrite rejects a mismatched kind or length', () => {
    const buf = native.createBuffer({ width: 4, height: 1, dtype: 'f32' });
    assert.throws(() => native.bufferWrite(buf, Int32Array.from([1, 2, 3, 4])), /dtype/);
    assert.throws(() => native.bufferWrite(buf, Float32Array.from([1, 2])), /element count/);
    assert.throws(() => native.bufferWrite(buf, [1, 2, 3, 4]), /typed array/);
  });

  await test('a 12 MP buffer round-trips at a sane cost', () => {
    const buf = native.createBuffer({ width: 4243, height: 2829, channels: 1 });
    const t0 = process.hrtime.bigint();
    const values = native.bufferRead(buf);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(values.length, 4243 * 2829);
    console.log(`       48 MB copied out in ${ms.toFixed(1)} ms`);
    native.bufferRelease(buf);
  });

  // --- hostile inputs, §3 ------------------------------------------------
  await test('rejects zero and negative dimensions', () => {
    assert.throws(() => native.createBuffer({ width: 0, height: 4 }), /between 1 and/);
    assert.throws(() => native.createBuffer({ width: 4, height: -1 }), /between 1 and/);
  });

  await test('rejects implausible dimensions before allocating', () => {
    assert.throws(() => native.createBuffer({ width: 1 << 21, height: 4 }), /between 1 and/);
  });

  await test('rejects a channel count outside 1..4', () => {
    assert.throws(() => native.createBuffer({ width: 4, height: 4, channels: 0 }), /channels/);
    assert.throws(() => native.createBuffer({ width: 4, height: 4, channels: 5 }), /channels/);
  });

  await test('rejects sizes that would overflow, without crashing', () => {
    // 1048576 x 1048576 x 4ch x 4B = 2^42 bytes. The multiply is checked and
    // the total exceeds CV_MAX_BYTES, so this must be refused, not attempted.
    assert.throws(
      () => native.createBuffer({ width: 1 << 20, height: 1 << 20, channels: 4 }),
      /overflow/
    );
  });

  await test('rejects unknown dtype and space', () => {
    assert.throws(() => native.createBuffer({ width: 2, height: 2, dtype: 'u8' }), /dtype/);
    assert.throws(() => native.createBuffer({ width: 2, height: 2, space: 'cmyk' }), /space/);
  });

  await test('rejects a non-handle', () => {
    assert.throws(() => native.bufferInfo({}), /buffer handle/);
  });

  // --- lifetime ----------------------------------------------------------
  await test('release is explicit, idempotent, and observable', () => {
    const buf = native.createBuffer({ width: 4, height: 4 });
    assert.equal(native.bufferInfo(buf).live, true);
    native.bufferRelease(buf);
    assert.equal(native.bufferInfo(buf).live, false);
    native.bufferRelease(buf); // must not double-free
    assert.throws(() => native.bufferRead(buf), /released/);
  });

  await test('a copied-out array outlives its buffer safely', () => {
    let values;
    {
      const buf = native.createBuffer({ width: 4, height: 1 });
      native.bufferWrite(buf, Float32Array.from([0, 7, 0, 0]));
      values = native.bufferRead(buf);
      native.bufferRelease(buf);
    }
    if (global.gc) { global.gc(); global.gc(); }
    assert.equal(values[1], 7, 'copy did not survive its source');
  });

  console.log(failures === 0 ? '\nAll buffer tests passed.' : `\n${failures} failing.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
