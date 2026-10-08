'use strict';

/**
 * The WebAssembly build against the addon, in one process.
 *
 * test/determinism.js run with CVLAB_BACKEND=wasm (`npm run test:wasm`)
 * checks the module against hashes written for the addon. This checks what a
 * fixed pipeline cannot reach:
 *
 *   - that the committed module is the one these sources build (its manifest);
 *   - that it imports nothing;
 *   - the two places where the module's libm meets the platform's: the
 *     8-bit transfer tables (`pow`, every byte value, both directions) and
 *     the Gaussian's taps (`exp`, over a range of sigma). The addon calls
 *     Apple's libm here, glibc or the UCRT on the other runners; the module
 *     always calls musl's, compiled in. They agree, bit for bit, and this
 *     is where it would show first if they stopped;
 *   - fitSegments and fitArcs on label maps drawn here, and the display
 *     path, field for field;
 *   - the errors: the same class and the same message for the same mistake.
 *
 *   node test/wasm.js
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const addon = require('../native');
const wasm = require('../native/wasm').load();
const { MANIFEST, OUT, sourceHashes } = require('../scripts/build-wasm');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const bits = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('hex');
const sameBits = (a, b, what) => {
  assert.equal(a.length, b.length, `${what}: length`);
  if (bits(a) === bits(b)) return;
  const i = a.findIndex((v, k) => !Object.is(v, b[k]));
  assert.fail(`${what}: differs first at ${i}: addon ${a[i]}, wasm ${b[i]}`);
};

/** The same buffer in both backends, from the same values. */
function both(spec, values) {
  return [addon, wasm].map((n) => {
    const h = n.createBuffer(spec);
    n.bufferWrite(h, values);
    return h;
  });
}

/** A label map: straight runs and two circles, drawn with integers only. */
function labelMap(width, height) {
  const labels = new Int32Array(width * height);
  const set = (x, y, id) => { if (x >= 0 && y >= 0 && x < width && y < height) labels[y * width + x] = id; };
  for (let x = 5; x < 60; x++) set(x, 10, 1);
  for (let k = 0; k < 40; k++) set(8 + k, 20 + Math.floor(k / 3), 2);
  for (let y = 30; y < 90; y++) set(70, y, 3);
  // Midpoint circles: integers and comparisons, so the fixture is the same everywhere.
  const circle = (cx, cy, r, id, from, to) => {
    let x = r, y = 0, err = 1 - r;
    while (x >= y) {
      for (const [dx, dy] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]]) {
        const octant = Math.atan2(dy, dx);
        if (octant >= from && octant <= to) set(cx + dx, cy + dy, id);
      }
      y++;
      if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
    }
  };
  circle(40, 60, 18, 4, -Math.PI, Math.PI);
  circle(90, 50, 25, 5, -0.5, 1.8);
  return labels;
}

console.log('cv-lab-2 WebAssembly tests');
console.log(`  (${process.platform}/${process.arch}, node ${process.versions.node}, addon against wasm)`);

test('the committed module is the one these sources build', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const now = sourceHashes();
  const stale = Object.keys(now).filter((f) => manifest.sources[f] !== now[f]);
  assert.deepEqual(stale, [], `changed since packages/vision/wasm/cvlab.wasm was built: ${stale.join(', ')} -- run npm run build:wasm`);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(OUT)).digest('hex');
  assert.equal(sha, manifest.sha256, 'cvlab.wasm is not the file its manifest describes');
});

test('the module imports nothing', () => {
  const module = new WebAssembly.Module(fs.readFileSync(OUT));
  assert.deepEqual(WebAssembly.Module.imports(module), []);
});

test('the same kernels, in the same order', () => {
  assert.deepEqual(wasm.kernelNames(), addon.kernelNames());
});

test('the 8-bit transfer tables agree for every byte, both ways (pow)', () => {
  const ramp = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) ramp.set([i, 255 - i, i, 255], i * 4);
  for (const [from, as] of [['srgb', 'linear'], ['linear', 'srgb'], ['srgb', 'srgb'], ['linear', 'linear']]) {
    const a = addon.bufferRead(addon.bufferFromRGBA8(ramp, 256, 1, { from, as }));
    const b = wasm.bufferRead(wasm.bufferFromRGBA8(ramp, 256, 1, { from, as }));
    sameBits(a, b, `${from} -> ${as}`);
  }
});

test('the per-pixel transfer functions agree on a fine ramp (pow)', () => {
  const n = 4096;
  const values = new Float32Array(n * 3);
  for (let i = 0; i < values.length; i++) values[i] = i / (values.length - 1);
  for (const [kernel, space] of [['toLinear', 'srgb'], ['toSrgb', 'linear']]) {
    const [a, b] = both({ width: n, height: 1, channels: 3, dtype: 'f32', space }, values);
    sameBits(addon.bufferRead(addon.runKernel(kernel, [a], {})),
      wasm.bufferRead(wasm.runKernel(kernel, [b], {})), kernel);
  }
});

test('the Gaussian agrees for every sigma tried (exp)', () => {
  const values = new Float32Array(48 * 48);
  for (let i = 0; i < values.length; i++) values[i] = ((i * 7919) % 1000) / 1000;
  const [a, b] = both({ width: 48, height: 48, channels: 1, dtype: 'f32' }, values);
  for (let k = 1; k <= 40; k++) {
    const sigma = 0.3 + k * 0.137;
    sameBits(addon.bufferRead(addon.runKernel('gaussian', [a], { sigma })),
      wasm.bufferRead(wasm.runKernel('gaussian', [b], { sigma })), `sigma ${sigma}`);
  }
});

test('orient agrees (atan2)', () => {
  const gx = new Float32Array(64 * 64), gy = new Float32Array(64 * 64);
  for (let i = 0; i < gx.length; i++) { gx[i] = Math.sin(i * 0.37) * 3; gy[i] = Math.cos(i * 0.11) * 2; }
  const [ax, bx] = both({ width: 64, height: 64, channels: 1, dtype: 'f32' }, gx);
  const [ay, by] = both({ width: 64, height: 64, channels: 1, dtype: 'f32' }, gy);
  for (const unsigned of [false, true]) {
    sameBits(addon.bufferRead(addon.runKernel('orient', [ax, ay], { unsigned })),
      wasm.bufferRead(wasm.runKernel('orient', [bx, by], { unsigned })), `unsigned=${unsigned}`);
  }
});

test('fitSegments and fitArcs give the same records, field for field', () => {
  const [a, b] = both({ width: 128, height: 96, channels: 1, dtype: 'i32' }, labelMap(128, 96));
  for (const fn of ['fitSegments', 'fitArcs']) {
    const fa = addon[fn](a), fb = wasm[fn](b);
    assert.ok(fa.length >= 3, `${fn}: the fixture should give records (${fa.length})`);
    assert.equal(JSON.stringify(fb), JSON.stringify(fa), fn);
    // JSON prints the shortest round-tripping decimal, so equal text is equal bits.
  }
  assert.deepEqual(addon.fitSegments(addon.createBuffer({ width: 4, height: 4, dtype: 'i32' })), []);
  assert.deepEqual(wasm.fitSegments(wasm.createBuffer({ width: 4, height: 4, dtype: 'i32' })), []);
});

test('a buffer hashes the same in both, and as node:crypto hashes its bytes', () => {
  for (const [width, height, channels] of [[1, 1, 1], [1, 14, 1], [1, 16, 1], [3, 5, 1], [13, 7, 3], [512, 512, 3]]) {
    const values = new Float32Array(width * height * channels);
    for (let i = 0; i < values.length; i++) values[i] = Math.sin(i) * 1000;
    const [a, b] = both({ width, height, channels, dtype: 'f32' }, values);
    const expected = crypto.createHash('sha256').update(Buffer.from(values.buffer)).digest('hex');
    assert.equal(addon.bufferHash(a), expected, `addon ${width}x${height}x${channels}`);
    assert.equal(wasm.bufferHash(b), expected, `wasm ${width}x${height}x${channels}`);
  }
});

test('the display path agrees: tiles, histograms, the probe', () => {
  const values = new Float32Array(80 * 60 * 3);
  for (let i = 0; i < values.length; i++) values[i] = ((i * 2654435761) % 4096) / 4096 - 0.2;
  const [a, b] = both({ width: 80, height: 60, channels: 3, dtype: 'f32' }, values);
  const specs = [
    { width: 40, height: 30 },
    { width: 33, height: 17, range: 'percentile', percentile: 5, curve: 'sqrt', colormap: 'viridis' },
    { width: 80, height: 60, range: 'symmetric', colormap: 'diverging', channel: 1, interpolate: false },
    { width: 20, height: 20, x: 10, y: 5, w: 30, h: 30, range: 'fixed', lo: 0.1, hi: 0.7, curve: 'log' },
  ];
  for (const spec of specs) {
    const ta = addon.renderTile(a, spec), tb = wasm.renderTile(b, spec);
    sameBits(ta.pixels, tb.pixels, `tile ${JSON.stringify(spec)}`);
    assert.deepEqual([tb.width, tb.height, tb.lo, tb.hi], [ta.width, ta.height, ta.lo, ta.hi]);
    const ha = addon.histogram(a, { ...spec, bins: 64 }), hb = wasm.histogram(b, { ...spec, bins: 64 });
    sameBits(ha.counts, hb.counts, 'histogram');
    assert.deepEqual([hb.lo, hb.hi], [ha.lo, ha.hi]);
  }
  for (const [x, y] of [[0, 0], [79, 59], [13, 41], [-1, 0], [80, 0]]) {
    assert.deepEqual(wasm.samplePixel(b, x, y), addon.samplePixel(a, x, y), `probe ${x},${y}`);
  }
});

test('the same mistake throws the same error', () => {
  const f = addon.createBuffer({ width: 4, height: 4 }), g = wasm.createBuffer({ width: 4, height: 4 });
  const l = addon.createBuffer({ width: 4, height: 4, dtype: 'i32', channels: 2 });
  const m = wasm.createBuffer({ width: 4, height: 4, dtype: 'i32', channels: 2 });
  const released = [addon, wasm].map((n) => { const h = n.createBuffer({ width: 2, height: 2 }); n.bufferRelease(h); return h; });
  const cases = [
    ['createBuffer', () => []],
    ['createBuffer', () => [7]],
    ['createBuffer', () => [{ width: 'a', height: 2 }]],
    ['createBuffer', () => [{ width: 2, height: 2, dtype: 'u8' }]],
    ['createBuffer', () => [{ width: 2, height: 2, space: 'cmyk' }]],
    ['createBuffer', () => [{ width: 0, height: 2 }]],
    ['createBuffer', () => [{ width: 2, height: 2, channels: 5 }]],
    ['createBuffer', () => [{ width: 2 ** 21, height: 2 }]],
    ['bufferInfo', () => [{}]],
    ['bufferWrite', (n) => [n === addon ? f : g, [1, 2]]],
    ['bufferWrite', (n) => [n === addon ? f : g, new Int32Array(16)]],
    ['bufferWrite', (n) => [n === addon ? f : g, new Float32Array(15)]],
    ['bufferRead', (n) => [released[n === addon ? 0 : 1]]],
    ['bufferFromRGBA8', () => [new Uint8Array(12), 2, 2]],
    ['bufferFromRGBA8', () => [new Float32Array(16), 2, 2]],
    ['bufferFromRGBA8', () => [new Uint8Array(16), 2, 2, { as: 'xyz' }]],
    ['runKernel', () => ['nope', []]],
    ['runKernel', () => ['gaussian', []]],
    ['runKernel', () => ['gaussian', [{}]]],
    ['runKernel', (n) => ['gaussian', [released[n === addon ? 0 : 1]]]],
    ['runKernel', (n) => ['gaussian', [n === addon ? f : g], 3]],
    ['runKernel', (n) => ['gaussian', [n === addon ? f : g], { sigma: -1 }]],
    ['runKernel', (n) => ['gaussian', [n === addon ? f : g], Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, i]))]],
    ['renderTile', (n) => [n === addon ? f : g, { width: 0, height: 4 }]],
    ['histogram', (n) => [n === addon ? f : g, { bins: 1 }]],
    ['samplePixel', (n) => [n === addon ? f : g, 1]],
    ['fitSegments', (n) => [n === addon ? f : g]],
    ['fitArcs', (n) => [n === addon ? l : m]],
    ['invertSync', () => [new Uint8Array(6)]],
    ['bufferHash', () => [{}]],
    ['bufferHash', (n) => [released[n === addon ? 0 : 1]]],
  ];
  const outcome = (n, fn, args) => {
    try { n[fn](...args(n)); return 'no error'; } catch (err) { return `${err.constructor.name}: ${err.message}`; }
  };
  for (const [fn, args] of cases) {
    const a = outcome(addon, fn, args), b = outcome(wasm, fn, args);
    assert.notEqual(a, 'no error', `${fn}: the case should be a mistake`);
    assert.equal(b, a, `${fn}(${args(addon).map((v) => typeof v).join(', ')})`);
  }
});

console.log(failures === 0 ? '\nAll WebAssembly tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);

