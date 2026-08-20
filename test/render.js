'use strict';

/**
 * Display path — design-lab-model.md §6, §8.
 *
 * The display transform must never alter the buffer, and the range/curve/
 * colormap combinations have to mean what §6 says they mean.
 *
 *   npm run build:native && node test/render.js
 */

const assert = require('node:assert/strict');
const native = require('../native');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const run = (name, inputs, params) => native.runKernel(name, inputs, params ?? {});
const px = (tile, i) => [tile.pixels[i * 4], tile.pixels[i * 4 + 1], tile.pixels[i * 4 + 2]];
const close = (a, b, tol = 1) => Math.abs(a - b) <= tol;

function signedRamp(width = 9) {
  // -1 .. +1 with an exact zero in the middle
  const buf = native.createBuffer({ width, height: 1, channels: 1, dtype: 'f32' });
  const half = (width - 1) / 2;
  native.bufferWrite(buf, Float32Array.from(
    Array.from({ length: width }, (_, i) => (i - half) / half)));
  return buf;
}

const runtime = process.versions.electron
  ? `electron ${process.versions.electron}` : `node ${process.versions.node}`;
console.log(`cv-lab-2 render tests (${runtime}, ${process.platform}/${process.arch})`);

/* --- the basics -------------------------------------------------------- */

test('gray maps the range ends to black and white', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 16, height: 1 });
  const tile = native.renderTile(ramp, { width: 16, height: 1, colormap: 'gray' });
  assert.deepEqual(px(tile, 0), [0, 0, 0]);
  assert.deepEqual(px(tile, 15), [255, 255, 255]);
  assert.equal(tile.pixels[3], 255, 'alpha should be opaque');
});

test('rendering never modifies the buffer', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 32, height: 1 });
  const before = [...native.bufferRead(ramp)];
  native.renderTile(ramp, { width: 8, height: 8, colormap: 'turbo', curve: 'log' });
  assert.deepEqual([...native.bufferRead(ramp)], before);
});

test('the tile is exactly the requested size', () => {
  const src = run('pattern', [], { kind: 'ramp', width: 100, height: 50 });
  const tile = native.renderTile(src, { width: 37, height: 11 });
  assert.equal(tile.width, 37);
  assert.equal(tile.height, 11);
  assert.equal(tile.pixels.length, 37 * 11 * 4);
});

test('downsampling box-averages continuous data', () => {
  // 64 -> 8 means each output pixel is the mean of 8 inputs. Nearest-neighbour
  // would give 0 for the first pixel; the average of 0..7/63 is 0.0556.
  const ramp = run('pattern', [], { kind: 'ramp', width: 64, height: 1 });
  const tile = native.renderTile(ramp, { width: 8, height: 1, colormap: 'gray' });
  const expected = Math.round((28 / 63 / 8) * 255);
  assert.ok(close(px(tile, 0)[0], expected), `got ${px(tile, 0)[0]}, expected ~${expected}`);
});

test('a source rect crops rather than scaling the whole image', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 16, height: 1 });
  const whole = native.renderTile(ramp, { width: 4, height: 1 });
  const right = native.renderTile(ramp, { width: 4, height: 1, x: 12, y: 0, w: 4, h: 1 });
  assert.notDeepEqual(px(whole, 0), px(right, 0));
  // The crop covers only the bright end, so auto-range spans much less.
  assert.ok(right.hi - right.lo < whole.hi - whole.lo);
});

/* --- range ------------------------------------------------------------- */

test('auto range reports the actual extremes', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 16, height: 1 });
  const tile = native.renderTile(ramp, { width: 16, height: 1, range: 'auto' });
  assert.ok(close(tile.lo, 0, 1e-6) && close(tile.hi, 1, 1e-6), `${tile.lo}..${tile.hi}`);
});

test('fixed range clamps outside the stated window', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 16, height: 1 });
  const tile = native.renderTile(ramp,
    { width: 16, height: 1, range: 'fixed', lo: 0.25, hi: 0.75, colormap: 'gray' });
  assert.deepEqual(px(tile, 0), [0, 0, 0], 'below lo should clamp to black');
  assert.deepEqual(px(tile, 15), [255, 255, 255], 'above hi should clamp to white');
});

test('symmetric range puts zero exactly on the midpoint', () => {
  // §6: this is what makes a diverging map honest about sign.
  const signed = signedRamp(9);
  const tile = native.renderTile(signed,
    { width: 9, height: 1, range: 'symmetric', colormap: 'diverging' });
  assert.ok(close(tile.lo, -1, 1e-6) && close(tile.hi, 1, 1e-6), `${tile.lo}..${tile.hi}`);
  const middle = px(tile, 4);
  assert.ok(middle[0] === middle[1] && middle[1] === middle[2],
    `zero should be neutral, got ${middle}`);
});

test('an asymmetric signed buffer still centres zero under symmetric range', () => {
  const buf = native.createBuffer({ width: 3, height: 1, channels: 1 });
  native.bufferWrite(buf, Float32Array.from([-0.25, 0, 1.0]));
  const tile = native.renderTile(buf,
    { width: 3, height: 1, range: 'symmetric', colormap: 'diverging' });
  assert.ok(close(tile.lo, -1, 1e-6) && close(tile.hi, 1, 1e-6));
  const zero = px(tile, 1);
  assert.ok(zero[0] === zero[1] && zero[1] === zero[2], `zero not neutral: ${zero}`);
});

test('percentile range ignores a single outlier', () => {
  const buf = native.createBuffer({ width: 100, height: 1, channels: 1 });
  const values = new Float32Array(100).fill(0.5);
  values[0] = 0;
  values[99] = 1000;                       // one hot pixel
  native.bufferWrite(buf, values);
  const auto = native.renderTile(buf, { width: 10, height: 1, range: 'auto' });
  const pct = native.renderTile(buf, { width: 10, height: 1, range: 'percentile', percentile: 2 });
  assert.ok(auto.hi >= 1000, 'auto should include the outlier');
  assert.ok(pct.hi < 10, `percentile should exclude it, got hi=${pct.hi}`);
});

/* --- curve ------------------------------------------------------------- */

test('abs folds negatives onto positives', () => {
  const signed = signedRamp(9);
  const tile = native.renderTile(signed,
    { width: 9, height: 1, curve: 'abs', range: 'auto', colormap: 'gray' });
  assert.deepEqual(px(tile, 0), px(tile, 8), '±1 should render identically under abs');
  assert.ok(close(tile.lo, 0, 1e-6), `lo should be 0, got ${tile.lo}`);
});

test('log compresses a wide range so small values stay visible', () => {
  const buf = native.createBuffer({ width: 4, height: 1, channels: 1 });
  native.bufferWrite(buf, Float32Array.from([0, 1, 10, 1000]));
  const linear = native.renderTile(buf, { width: 4, height: 1, curve: 'linear' });
  const log = native.renderTile(buf, { width: 4, height: 1, curve: 'log' });
  assert.ok(px(linear, 2)[0] < 5, 'under linear, 10 is lost next to 1000');
  assert.ok(px(log, 2)[0] > 60, `under log it should be visible, got ${px(log, 2)[0]}`);
});

test('sqrt sits between linear and log on a wide range', () => {
  const buf = native.createBuffer({ width: 3, height: 1, channels: 1 });
  native.bufferWrite(buf, Float32Array.from([0, 1, 1000]));
  const get = (curve) => px(native.renderTile(buf, { width: 3, height: 1, curve }), 1)[0];
  assert.ok(get('linear') < get('sqrt') && get('sqrt') < get('log'),
    `linear ${get('linear')} < sqrt ${get('sqrt')} < log ${get('log')}`);
});

test('on a narrow range sqrt lifts small values MORE than log', () => {
  // Not a contradiction of the above: log1p is close to linear on [0,1], so
  // the usual "sqrt is gentler than log" ordering only holds once the data
  // spans orders of magnitude. Worth pinning down, because the opposite is
  // the natural assumption.
  const buf = native.createBuffer({ width: 3, height: 1, channels: 1 });
  native.bufferWrite(buf, Float32Array.from([0, 0.1, 1]));
  const get = (curve) => px(native.renderTile(buf, { width: 3, height: 1, curve }), 1)[0];
  assert.ok(get('sqrt') > get('log'),
    `sqrt ${get('sqrt')} should exceed log ${get('log')} on [0,1]`);
});

/* --- colormaps --------------------------------------------------------- */

test('viridis starts dark purple and ends bright yellow', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 2, height: 1 });
  const tile = native.renderTile(ramp, { width: 2, height: 1, colormap: 'viridis' });
  const [r0, g0, b0] = px(tile, 0);
  const [r1, g1, b1] = px(tile, 1);
  assert.ok(b0 > r0 && b0 > g0, `low end should be blue-ish, got ${[r0, g0, b0]}`);
  assert.ok(r1 > 200 && g1 > 200 && b1 < 100, `high end should be yellow, got ${[r1, g1, b1]}`);
});

test('viridis is monotonic in lightness; turbo is not', () => {
  // The property that makes viridis safe for judging magnitude, and the one
  // turbo trades away for discriminability (§6).
  const ramp = run('pattern', [], { kind: 'ramp', width: 64, height: 1 });
  const lightness = (map) => {
    const tile = native.renderTile(ramp, { width: 64, height: 1, colormap: map });
    return Array.from({ length: 64 }, (_, i) => {
      const [r, g, b] = px(tile, i);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    });
  };
  const v = lightness('viridis');
  let vDrops = 0;
  for (let i = 1; i < v.length; i++) if (v[i] < v[i - 1] - 1) vDrops++;
  assert.equal(vDrops, 0, `viridis lightness dropped ${vDrops} times`);

  const t = lightness('turbo');
  let tDrops = 0;
  for (let i = 1; i < t.length; i++) if (t[i] < t[i - 1] - 1) tDrops++;
  assert.ok(tDrops > 0, 'turbo should not be lightness-monotonic');
});

test('categorical uses only palette colours and never interpolates', () => {
  const buf = native.createBuffer({ width: 6, height: 1, channels: 1, dtype: 'i32' });
  native.bufferWrite(buf, Int32Array.from([0, 1, 2, 3, 1, 0]));
  // Upscaling would invent in-between colours if it interpolated.
  const tile = native.renderTile(buf, { width: 24, height: 1, colormap: 'categorical' });
  const unique = new Set();
  for (let i = 0; i < 24; i++) unique.add(px(tile, i).join(','));
  assert.ok(unique.size <= 4, `expected at most 4 distinct colours, got ${unique.size}`);
  assert.deepEqual(px(tile, 0), [0, 0, 0], 'label 0 is background');
});

test('equal labels get equal colours, different labels differ', () => {
  const buf = native.createBuffer({ width: 4, height: 1, channels: 1, dtype: 'i32' });
  native.bufferWrite(buf, Int32Array.from([5, 7, 5, 7]));
  const tile = native.renderTile(buf, { width: 4, height: 1, colormap: 'categorical' });
  assert.deepEqual(px(tile, 0), px(tile, 2));
  assert.notDeepEqual(px(tile, 0), px(tile, 1));
});

/* --- channels ---------------------------------------------------------- */

test('a 3-channel buffer composites to colour by default', () => {
  const buf = native.createBuffer({ width: 1, height: 1, channels: 3 });
  native.bufferWrite(buf, Float32Array.from([1, 0, 0]));
  const tile = native.renderTile(buf, { width: 1, height: 1, range: 'fixed', lo: 0, hi: 1 });
  assert.deepEqual(px(tile, 0), [255, 0, 0], 'red should render red, not grey');
});

test('selecting a channel shows that channel alone', () => {
  const buf = native.createBuffer({ width: 1, height: 1, channels: 3 });
  native.bufferWrite(buf, Float32Array.from([1, 0, 0]));
  const green = native.renderTile(buf,
    { width: 1, height: 1, channel: 1, range: 'fixed', lo: 0, hi: 1, colormap: 'gray' });
  assert.deepEqual(px(green, 0), [0, 0, 0], 'green channel of pure red is 0');
});

/* --- histogram and probe ----------------------------------------------- */

test('histogram counts every element exactly once', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 64, height: 8 });
  const h = native.histogram(ramp, { bins: 16 });
  const total = [...h.counts].reduce((a, b) => a + b, 0);
  assert.equal(total, 64 * 8);
});

test('histogram of a constant field lands in one bin', () => {
  const flat = run('pattern', [], { kind: 'constant', width: 32, height: 32, value: 0.4 });
  const h = native.histogram(flat, { bins: 64 });
  assert.equal([...h.counts].filter((c) => c > 0).length, 1);
});

test('histogram respects the curve', () => {
  const buf = native.createBuffer({ width: 4, height: 1, channels: 1 });
  native.bufferWrite(buf, Float32Array.from([0, 1, 10, 1000]));
  const linear = native.histogram(buf, { bins: 8, curve: 'linear' });
  const log = native.histogram(buf, { bins: 8, curve: 'log' });
  assert.equal(linear.counts[0], 3, 'linear crams the small values into one bin');
  assert.ok([...log.counts].filter((c) => c > 0).length > 1, 'log should spread them');
});

test('samplePixel reads exact values and refuses to go out of bounds', () => {
  const buf = native.createBuffer({ width: 2, height: 2, channels: 3 });
  native.bufferWrite(buf, Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  assert.deepEqual(native.samplePixel(buf, 0, 0), [1, 2, 3]);
  assert.deepEqual(native.samplePixel(buf, 1, 1), [10, 11, 12]);
  assert.equal(native.samplePixel(buf, 2, 0), null);
  assert.equal(native.samplePixel(buf, -1, 0), null);
});

/* --- robustness -------------------------------------------------------- */

test('rendering is deterministic', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 128, height: 128 });
  const spec = { width: 64, height: 64, colormap: 'viridis', range: 'percentile' };
  const a = native.renderTile(ramp, spec).pixels;
  const b = native.renderTile(ramp, spec).pixels;
  assert.deepEqual([...a], [...b]);
});

test('absurd tile sizes and released buffers are refused', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 8, height: 8 });
  assert.throws(() => native.renderTile(ramp, { width: 0, height: 8 }), /between 1 and 16384/);
  assert.throws(() => native.renderTile(ramp, { width: 99999, height: 8 }), /between 1 and 16384/);
  native.bufferRelease(ramp);
  assert.throws(() => native.renderTile(ramp, { width: 4, height: 4 }), /released/);
});

console.log(failures === 0 ? '\nAll render tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
