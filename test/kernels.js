'use strict';

/**
 * Kernel correctness — design-lab-model.md §3.
 *
 * These assert behaviour against values worked out on paper, not against
 * whatever the code happened to produce. A test that only records current
 * output cannot tell you the kernel is wrong.
 *
 *   npm run build:native && node test/kernels.js
 */

const assert = require('node:assert/strict');
const native = require('../native');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const read = (h) => [...native.bufferRead(h)];
const run = (name, inputs, params) => native.runKernel(name, inputs, params ?? {});
const close = (a, b, tol = 1e-5) => Math.abs(a - b) <= tol;

function assertClose(actual, expected, tol, message) {
  assert.equal(actual.length, expected.length, `${message}: length`);
  actual.forEach((v, i) => {
    assert.ok(close(v, expected[i], tol),
      `${message}: index ${i} — expected ${expected[i]}, got ${v}`);
  });
}

const runtime = process.versions.electron
  ? `electron ${process.versions.electron}` : `node ${process.versions.node}`;
console.log(`cv-lab-2 kernel tests (${runtime}, ${process.platform}/${process.arch})`);

/* --- the table --------------------------------------------------------- */

test('every kernel is reachable by name', () => {
  assert.deepEqual(native.kernelNames(),
    ['pattern', 'gray', 'gaussian', 'sobel', 'threshold', 'stats', 'toLinear',
     'toSrgb', 'nms', 'hysteresis', 'orient']);
});

test('an unknown kernel and a wrong input count are refused', () => {
  assert.throws(() => run('nope', []), /no kernel named/);
  assert.throws(() => run('gray', []), /takes 1 input/);
});

/* --- pattern ----------------------------------------------------------- */

test('ramp spans 0..1 across the width', () => {
  const p = run('pattern', [], { kind: 'ramp', width: 5, height: 1, channels: 1 });
  assertClose(read(p), [0, 0.25, 0.5, 0.75, 1], 1e-6, 'ramp');
});

test('checker alternates in 8-pixel blocks', () => {
  const p = run('pattern', [], { kind: 'checker', width: 16, height: 1, channels: 1 });
  const row = read(p);
  assert.equal(row[0], 0);
  assert.equal(row[7], 0);
  assert.equal(row[8], 1);
});

test('impulse is a single lit pixel', () => {
  const p = run('pattern', [], { kind: 'impulse', width: 5, height: 5, channels: 1 });
  const values = read(p);
  assert.equal(values.filter((v) => v !== 0).length, 1);
  assert.equal(values[2 * 5 + 2], 1);
});

/* --- gray -------------------------------------------------------------- */

test('gray applies Rec.709 luminance weights', () => {
  const src = run('pattern', [], { kind: 'constant', width: 1, height: 1, channels: 3, value: 0 });
  // constant fills every channel equally, so build the test colour by hand
  native.bufferWrite(src, Float32Array.from([1, 0, 0]));
  assertClose(read(run('gray', [src])), [0.2126], 1e-6, 'pure red');
  native.bufferWrite(src, Float32Array.from([0, 1, 0]));
  assertClose(read(run('gray', [src])), [0.7152], 1e-6, 'pure green');
  native.bufferWrite(src, Float32Array.from([0, 0, 1]));
  assertClose(read(run('gray', [src])), [0.0722], 1e-6, 'pure blue');
  native.bufferWrite(src, Float32Array.from([1, 1, 1]));
  assertClose(read(run('gray', [src])), [1], 1e-6, 'white stays 1');
});

test('gray refuses anything but 3 channels', () => {
  const mono = run('pattern', [], { kind: 'ramp', width: 4, height: 1, channels: 1 });
  assert.throws(() => run('gray', [mono]), /channels/);
});

test('gray preserves the input colour space', () => {
  const rgb = run('pattern', [], { kind: 'ramp', width: 4, height: 4, channels: 3 });
  assert.equal(native.bufferInfo(rgb).space, 'linear');
  assert.equal(native.bufferInfo(run('gray', [rgb])).space, 'linear');
});

/* --- gaussian ---------------------------------------------------------- */

test('gaussian preserves a constant field exactly', () => {
  // A normalised kernel over a constant must return that constant; anything
  // else means the weights do not sum to 1 or the border is wrong.
  const flat = run('pattern', [], { kind: 'constant', width: 16, height: 16, value: 0.25 });
  const blurred = read(run('gaussian', [flat], { sigma: 2.5 }));
  assertClose(blurred, new Array(256).fill(0.25), 1e-5, 'constant');
});

test('gaussian preserves a linear ramp in the interior', () => {
  // A symmetric normalised kernel leaves a linear function unchanged away
  // from the edges. This catches an asymmetric or mis-centred kernel.
  const ramp = run('pattern', [], { kind: 'ramp', width: 32, height: 1 });
  const before = read(ramp);
  const after = read(run('gaussian', [ramp], { sigma: 1.5 }));
  for (let i = 8; i < 24; i++) {
    assert.ok(close(after[i], before[i], 1e-5),
      `index ${i}: ${after[i]} vs ${before[i]}`);
  }
});

test('gaussian conserves total energy on an impulse', () => {
  const impulse = run('pattern', [], { kind: 'impulse', width: 33, height: 33 });
  const sum = read(run('gaussian', [impulse], { sigma: 2 })).reduce((a, b) => a + b, 0);
  assert.ok(close(sum, 1, 1e-4), `energy ${sum} should be 1`);
});

test('gaussian is symmetric about an impulse', () => {
  const impulse = run('pattern', [], { kind: 'impulse', width: 21, height: 1 });
  const out = read(run('gaussian', [impulse], { sigma: 1.5 }));
  for (let k = 1; k <= 5; k++) {
    assert.ok(close(out[10 - k], out[10 + k], 1e-6), `asymmetric at ±${k}`);
  }
});

test('gaussian rejects a non-positive sigma', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 4, height: 1 });
  assert.throws(() => run('gaussian', [ramp], { sigma: 0 }), /width and height|dimensions/);
});

/* --- sobel ------------------------------------------------------------- */

test('sobel gives zero response on a constant field', () => {
  const flat = run('pattern', [], { kind: 'constant', width: 8, height: 8, value: 0.7 });
  const out = read(run('sobel', [flat], { axis: 'mag' }));
  assert.ok(out.every((v) => close(v, 0, 1e-6)), 'constant field produced an edge');
});

test('sobel x on a linear ramp is the constant slope', () => {
  // 8 samples spanning 0..1 → slope 1/7. Divided by 8 (sum of |weights|),
  // the interior response should equal the slope itself.
  const ramp = run('pattern', [], { kind: 'ramp', width: 8, height: 3 });
  const out = read(run('sobel', [ramp], { axis: 'x' }));
  const slope = 1 / 7;
  for (let x = 1; x < 7; x++) {
    assert.ok(close(out[8 + x], slope, 1e-5), `x=${x}: ${out[8 + x]} vs ${slope}`);
  }
});

test('sobel y is zero on a horizontal ramp', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 8, height: 8 });
  const out = read(run('sobel', [ramp], { axis: 'y' }));
  assert.ok(out.every((v) => close(v, 0, 1e-6)), 'vertical derivative should vanish');
});

test('sobel x output is signed', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 8, height: 1 });
  const forward = read(run('sobel', [ramp], { axis: 'x' }));
  const reversed = run('pattern', [], { kind: 'ramp', width: 8, height: 1 });
  native.bufferWrite(reversed, Float32Array.from([...read(ramp)].reverse()));
  const backward = read(run('sobel', [reversed], { axis: 'x' }));
  assert.ok(forward[4] > 0 && backward[4] < 0, 'sign did not flip with the ramp');
});

test('sobel magnitude equals hypot of the two axes', () => {
  const checker = run('pattern', [], { kind: 'checker', width: 32, height: 32 });
  const gx = read(run('sobel', [checker], { axis: 'x' }));
  const gy = read(run('sobel', [checker], { axis: 'y' }));
  const mag = read(run('sobel', [checker], { axis: 'mag' }));
  for (let i = 0; i < mag.length; i += 37) {
    assert.ok(close(mag[i], Math.hypot(gx[i], gy[i]), 1e-5), `index ${i}`);
  }
});

test('sobel output carries no colour space', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 4, height: 4 });
  assert.equal(native.bufferInfo(run('sobel', [ramp])).space, 'none');
});

/* --- threshold --------------------------------------------------------- */

test('threshold produces an i32 mask of 0 and 1', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 5, height: 1 });
  const out = run('threshold', [ramp], { t: 0.5, invert: false });
  assert.equal(native.bufferInfo(out).dtype, 'i32');
  assert.equal(native.bufferInfo(out).space, 'none');
  assert.deepEqual(read(out), [0, 0, 0, 1, 1]); // 0.5 is not > 0.5
});

test('invert flips the mask exactly', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 5, height: 1 });
  const plain = read(run('threshold', [ramp], { t: 0.5, invert: false }));
  const flipped = read(run('threshold', [ramp], { t: 0.5, invert: true }));
  assert.deepEqual(flipped, plain.map((v) => 1 - v));
});

test('threshold is invariant under a monotonic transform of the input', () => {
  // §2: ordering survives a gamma curve, so the SET of selected pixels is the
  // same once the threshold is mapped through the same curve.
  const ramp = run('pattern', [], { kind: 'ramp', width: 64, height: 1 });
  const linear = read(ramp);
  const gamma = run('pattern', [], { kind: 'ramp', width: 64, height: 1 });
  native.bufferWrite(gamma, Float32Array.from(linear.map((v) => Math.pow(v, 1 / 2.2))));
  const a = read(run('threshold', [ramp], { t: 0.5 }));
  const b = read(run('threshold', [gamma], { t: Math.pow(0.5, 1 / 2.2) }));
  assert.deepEqual(a, b);
});

/* --- stats ------------------------------------------------------------- */

test('stats matches values computed by hand', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 5, height: 1 });
  const s = run('stats', [ramp]);
  assert.equal(s.count, 5);
  assert.ok(close(s.min, 0) && close(s.max, 1), 'min/max');
  assert.ok(close(s.mean, 0.5), `mean ${s.mean}`);
  // population sd of [0,.25,.5,.75,1] = sqrt(0.125) = 0.3535533906
  assert.ok(close(s.stddev, Math.sqrt(0.125), 1e-6), `stddev ${s.stddev}`);
});

test('stats reads i32 buffers too', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 8, height: 1 });
  const mask = run('threshold', [ramp], { t: 0.5 });
  const s = run('stats', [mask]);
  assert.equal(s.count, 8);
  assert.ok(close(s.mean, read(mask).reduce((a, b) => a + b, 0) / 8));
});

test('stats is bit-identical across repeated runs', () => {
  // §5, determinism rule 1: the tiled reduction has a fixed summation order,
  // so parallelising it later cannot change the answer.
  const noise = run('pattern', [], { kind: 'ramp', width: 512, height: 512 });
  const first = run('stats', [noise]);
  for (let i = 0; i < 5; i++) {
    const again = run('stats', [noise]);
    assert.equal(again.mean, first.mean, 'mean drifted between runs');
    assert.equal(again.stddev, first.stddev, 'stddev drifted between runs');
  }
});

/* --- colour space conversion ------------------------------------------- */

test('toLinear matches the standard sRGB transfer function', () => {
  const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const src = run('pattern', [], { kind: 'ramp', width: 16, height: 1 });
  const before = read(src);
  const after = read(run('toLinear', [src]));
  before.forEach((v, i) => {
    assert.ok(close(after[i], srgbToLinear(v), 1e-6),
      `${v}: expected ${srgbToLinear(v)}, got ${after[i]}`);
  });
  assert.equal(native.bufferInfo(run('toLinear', [src])).space, 'linear');
});

test('toSrgb is the inverse of toLinear', () => {
  const src = run('pattern', [], { kind: 'ramp', width: 64, height: 1 });
  const before = read(src);
  const round = read(run('toSrgb', [run('toLinear', [src])]));
  before.forEach((v, i) => {
    assert.ok(close(round[i], v, 1e-5), `round trip lost ${v} -> ${round[i]}`);
  });
});

test('conversion is exact at the endpoints and across the knee', () => {
  const buf = native.createBuffer({ width: 4, height: 1, channels: 1 });
  native.bufferWrite(buf, Float32Array.from([0, 0.04045, 0.05, 1]));
  const out = read(run('toLinear', [buf]));
  assert.ok(close(out[0], 0, 1e-9) && close(out[3], 1, 1e-6), 'endpoints');
  assert.ok(close(out[1], 0.04045 / 12.92, 1e-7), 'at the knee, linear segment');
  assert.ok(close(out[2], Math.pow((0.05 + 0.055) / 1.055, 2.4), 1e-7), 'above the knee');
});

test('values outside 0..1 pass through rather than being clamped', () => {
  // The transfer function is only defined on the unit interval; clamping
  // would destroy data a derived buffer legitimately holds.
  const buf = native.createBuffer({ width: 3, height: 1, channels: 1 });
  native.bufferWrite(buf, Float32Array.from([-0.5, 0.5, 2.0]));
  const out = read(run('toLinear', [buf]));
  assert.equal(out[0], -0.5);
  assert.equal(out[2], 2.0);
  assert.ok(out[1] < 0.5, 'in-range values still convert');
});

/* --- orient: gradient direction ---------------------------------------- */

const DEG = 180 / Math.PI;

function edge(fn, w = 8, h = 8) {
  const b = native.createBuffer({ width: w, height: h, channels: 1, dtype: 'f32' });
  const v = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v.push(fn(x, y));
  native.bufferWrite(b, Float32Array.from(v));
  return b;
}
function angleAt(img, opts, x = 4, y = 4, w = 8) {
  const gx = run('sobel', [img], { axis: 'x' });
  const gy = run('sobel', [img], { axis: 'y' });
  return read(run('orient', [gx, gy], opts))[y * w + x] * DEG;
}

test('orient gives the direction brightness increases', () => {
  // The gradient points ACROSS the edge, never along it.
  assert.ok(close(angleAt(edge((x) => (x < 4 ? 0 : 1)), {}), 0, 1e-3),
    'dark left, bright right -> gradient points +x');
  assert.ok(close(angleAt(edge((x, y) => (y < 4 ? 0 : 1)), {}), 90, 1e-3),
    'dark top, bright below -> gradient points +y');
});

test('signed keeps the two sides of an edge 180 degrees apart', () => {
  const a = angleAt(edge((x) => (x < 4 ? 0 : 1)), { range: 'signed' });
  const b = angleAt(edge((x) => (x < 4 ? 1 : 0)), { range: 'signed' });
  assert.ok(close(Math.abs(a - b), 180, 1e-3), `${a} and ${b} should differ by 180`);
});

test('unsigned folds them together', () => {
  const a = angleAt(edge((x) => (x < 4 ? 0 : 1)), { range: 'unsigned' });
  const b = angleAt(edge((x) => (x < 4 ? 1 : 0)), { range: 'unsigned' });
  assert.ok(close(a, b, 1e-3), `${a} and ${b} should agree once folded`);
});

test('unsigned output stays inside [0, pi)', () => {
  // A plain `if (angle < 0) angle += pi` passes every test but this one:
  // atan2 returns exactly +pi for a gradient along -x, which is not negative.
  for (const fn of [
    (x) => (x < 4 ? 1 : 0),          // gradient along -x, atan2 = +pi exactly
    (x) => (x < 4 ? 0 : 1),
    (x, y) => (y < 4 ? 1 : 0),
    (x, y) => (y < 4 ? 0 : 1),
    (x, y) => ((x + y) < 8 ? 0 : 1),
  ]) {
    const gx = run('sobel', [edge(fn)], { axis: 'x' });
    const gy = run('sobel', [edge(fn)], { axis: 'y' });
    for (const v of read(run('orient', [gx, gy], { range: 'unsigned' }))) {
      assert.ok(v >= 0 && v < Math.PI, `${v} is outside [0, pi)`);
    }
  }
});

test('a flat region gets a defined angle rather than noise', () => {
  const flat = run('pattern', [], { kind: 'constant', width: 8, height: 8, value: 0.5 });
  const gx = run('sobel', [flat], { axis: 'x' });
  const gy = run('sobel', [flat], { axis: 'y' });
  assert.ok(read(run('orient', [gx, gy])).every((v) => v === 0),
    'no gradient means no direction; 0 is emitted deliberately');
});

test('orient rejects mismatched shapes and a bad range', () => {
  const a = run('pattern', [], { kind: 'ramp', width: 8, height: 8 });
  const b = run('pattern', [], { kind: 'ramp', width: 4, height: 4 });
  assert.throws(() => run('orient', [a, b]), /same dimensions/);
  assert.throws(() => run('orient', [a, a], { range: 'sideways' }), /parameter out of range/);
});

test('a straight edge has one constant orientation along its length', () => {
  // The property the segment grower will depend on: pixels of the same
  // straight edge agree on direction, so they can be grown into one region.
  const W = 32;
  const diagonal = edge((x, y) => ((x - y) < 0 ? 0 : 1), W, W);
  const gx = run('sobel', [diagonal], { axis: 'x' });
  const gy = run('sobel', [diagonal], { axis: 'y' });
  const mag = read(run('sobel', [diagonal], { axis: 'mag' }));
  const ang = read(run('orient', [gx, gy]));

  // Excluding a one-pixel border, and that exclusion is the point rather than
  // a convenience: at the image edge, reflect-padding fabricates neighbours
  // that are not there, so the gradient — and therefore the orientation — is
  // wrong. Measured on this fixture, the interior spread is 0.00 degrees and
  // including the border makes it 53. Anything growing regions from this
  // field has to ignore the border for the same reason.
  const interior = [];
  for (let y = 1; y < W - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (mag[i] > 0.05) interior.push(ang[i] * DEG);
    }
  }
  assert.ok(interior.length > 100, `only ${interior.length} edge pixels found`);
  const spread = Math.max(...interior) - Math.min(...interior);
  assert.ok(spread < 0.01, `orientation varies by ${spread.toFixed(2)} degrees`);
  assert.ok(close(interior[0], -45, 0.01),
    `a 45-degree edge should have a -45-degree gradient, got ${interior[0]}`);
});

test('orientation is unreliable at the image border', () => {
  // Recorded deliberately, because it is a property of reflect-padding rather
  // than of orient, and the next stage needs to know it.
  const W = 32;
  const diagonal = edge((x, y) => ((x - y) < 0 ? 0 : 1), W, W);
  const gx = run('sobel', [diagonal], { axis: 'x' });
  const gy = run('sobel', [diagonal], { axis: 'y' });
  const mag = read(run('sobel', [diagonal], { axis: 'mag' }));
  const ang = read(run('orient', [gx, gy]));
  const all = [];
  for (let i = 0; i < ang.length; i++) if (mag[i] > 0.05) all.push(ang[i] * DEG);
  assert.ok(Math.max(...all) - Math.min(...all) > 10,
    'expected border pixels to disagree — if this fails, padding changed');
});

/* --- nms: Canny stage 3 ------------------------------------------------- */

function mono(values, width, height = 1) {
  const b = native.createBuffer({ width, height, channels: 1, dtype: 'f32' });
  native.bufferWrite(b, Float32Array.from(values));
  return b;
}
const fill = (n, v) => mono(new Array(n).fill(v), n);

test('nms keeps only the maximum across the gradient direction', () => {
  const out = read(run('nms',
    [mono([0, 1, 2, 1, 0], 5), fill(5, 1), fill(5, 0)]));
  assert.deepEqual(out, [0, 0, 2, 0, 0]);
});

test('nms thins a ridge exactly two pixels wide to one', () => {
  // The reason the comparison is asymmetric: with >= on both sides these two
  // equal pixels would both survive, and thinning is the whole job.
  const out = read(run('nms',
    [mono([0, 2, 2, 0], 4), fill(4, 1), fill(4, 0)]));
  assert.deepEqual(out, [0, 2, 0, 0]);
});

test('nms follows the gradient direction, not the image axes', () => {
  // Same magnitudes, different gradient: the answer must change.
  const mag = () => mono([0, 1, 2, 1, 0], 5);
  const across = read(run('nms', [mag(), fill(5, 1), fill(5, 0)]));   // horizontal
  const along = read(run('nms', [mag(), fill(5, 0), fill(5, 1)]));    // vertical
  assert.deepEqual(across, [0, 0, 2, 0, 0], 'thins across a horizontal gradient');
  assert.deepEqual(along, [0, 0, 0, 0, 0],
    'a vertical gradient has no vertical neighbours in a 1-row image');
});

test('nms handles a diagonal gradient', () => {
  const grid = (v) => mono(v, 3, 3);
  const gx = mono(new Array(9).fill(1), 3, 3);
  const gy = mono(new Array(9).fill(1), 3, 3);
  // centre is the max along the (1,1) diagonal
  let out = read(run('nms', [grid([1,0,0, 0,2,0, 0,0,1]), gx, gy]));
  assert.equal(out[4], 2, 'centre should survive');
  // now a larger neighbour sits on that diagonal
  out = read(run('nms', [grid([3,0,0, 0,2,0, 0,0,1]), gx, gy]));
  assert.equal(out[4], 0, 'centre should be suppressed by the diagonal neighbour');
});

test('nms leaves zero magnitude alone and rejects mismatched shapes', () => {
  assert.deepEqual(read(run('nms', [fill(4, 0), fill(4, 1), fill(4, 0)])), [0, 0, 0, 0]);
  assert.throws(() => run('nms', [mono([1, 2, 3], 3), fill(4, 1), fill(4, 0)]),
    /same dimensions/);
  assert.throws(() => native.runKernel('nms', [fill(4, 1), fill(4, 1)], {}), /takes 3 input/);
});

test('nms reduces the number of lit pixels on a real edge map', () => {
  const checker = run('pattern', [], { kind: 'checker', width: 64, height: 64 });
  const blurred = run('gaussian', [checker], { sigma: 1.4 });
  const mag = run('sobel', [blurred], { axis: 'mag' });
  const gx = run('sobel', [blurred], { axis: 'x' });
  const gy = run('sobel', [blurred], { axis: 'y' });
  const thinned = read(run('nms', [mag, gx, gy]));
  const before = read(mag).filter((v) => v > 1e-4).length;
  const after = thinned.filter((v) => v > 1e-4).length;
  assert.ok(after < before * 0.75, `expected thinning: ${before} -> ${after}`);
  assert.ok(after > 0, 'everything was suppressed');
});

/* --- hysteresis: Canny stage 4 ------------------------------------------ */

test('hysteresis keeps weak pixels connected to a strong one', () => {
  const out = read(run('hysteresis', [mono([0.2, 0.07, 0.07, 0.0, 0.07], 5)],
    { low: 0.05, high: 0.15 }));
  //          strong  weak   weak   gap   isolated weak
  assert.deepEqual(out, [1, 1, 1, 0, 0]);
});

test('hysteresis drops a weak run with no strong seed', () => {
  const out = read(run('hysteresis', [mono([0.07, 0.07, 0.07], 3)], { low: 0.05, high: 0.15 }));
  assert.deepEqual(out, [0, 0, 0]);
});

test('hysteresis connects diagonally, not just orthogonally', () => {
  const b = native.createBuffer({ width: 3, height: 3, channels: 1 });
  native.bufferWrite(b, Float32Array.from([
    0.2, 0.0, 0.0,
    0.0, 0.07, 0.0,
    0.0, 0.0, 0.07,
  ]));
  const out = read(run('hysteresis', [b], { low: 0.05, high: 0.15 }));
  assert.deepEqual(out, [1, 0, 0, 0, 1, 0, 0, 0, 1], '8-connectivity expected');
});

test('hysteresis does not wrap around an image edge', () => {
  // Reflection is right for a convolution and wrong for connectivity: the
  // last pixel of one row does not touch the first pixel of the next.
  const b = native.createBuffer({ width: 3, height: 2, channels: 1 });
  native.bufferWrite(b, Float32Array.from([
    0.0, 0.0, 0.2,
    0.07, 0.0, 0.0,
  ]));
  const out = read(run('hysteresis', [b], { low: 0.05, high: 0.15 }));
  assert.equal(out[3], 0, 'row 1 column 0 must not be reached from row 0 column 2');
});

test('hysteresis output is an i32 mask with no colour space', () => {
  const info = native.bufferInfo(run('hysteresis', [mono([0.2], 1)], { low: 0.05, high: 0.15 }));
  assert.equal(info.dtype, 'i32');
  assert.equal(info.space, 'none');
});

test('hysteresis refuses low above high', () => {
  assert.throws(() => run('hysteresis', [mono([0.2], 1)], { low: 0.5, high: 0.1 }),
    /low must not exceed high/);
});

test('hysteresis is deterministic', () => {
  const checker = run('pattern', [], { kind: 'checker', width: 48, height: 48 });
  const blurred = run('gaussian', [checker], { sigma: 1.2 });
  const mag = run('sobel', [blurred], { axis: 'mag' });
  const first = read(run('hysteresis', [mag], { low: 0.02, high: 0.06 }));
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(read(run('hysteresis', [mag], { low: 0.02, high: 0.06 })), first);
  }
});

test('a full Canny chain finds exactly the checkerboard boundaries', () => {
  // A 64x64 checkerboard of 8-pixel blocks has 7 internal vertical and 7
  // internal horizontal boundaries. That makes the answer checkable against
  // geometry rather than against a tolerance someone guessed.
  const W = 64;
  const checker = run('pattern', [], { kind: 'checker', width: W, height: W });
  const blurred = run('gaussian', [checker], { sigma: 1.4 });
  const gx = run('sobel', [blurred], { axis: 'x' });
  const gy = run('sobel', [blurred], { axis: 'y' });
  const mag = run('sobel', [blurred], { axis: 'mag' });
  const edges = read(run('hysteresis', [run('nms', [mag, gx, gy])],
    { low: 0.01, high: 0.04 }));

  assert.ok(edges.every((v) => v === 0 || v === 1), 'mask must be 0/1 only');

  // Row 4 sits inside a block vertically, so it crosses only the vertical
  // boundaries: one lit pixel each, and nothing else.
  const row = edges.slice(4 * W, 5 * W);
  assert.equal(row.filter((v) => v === 1).length, 7,
    `expected one pixel per internal vertical boundary, got ${row.join('')}`);

  // And each of those is a single pixel: no two adjacent. This is what nms
  // is for — before thinning, a blurred edge is several pixels wide.
  for (let x = 1; x < W; x++) {
    assert.ok(!(row[x] === 1 && row[x - 1] === 1),
      `edge is more than one pixel wide at x=${x}`);
  }

  // Lit pixels land on boundaries, never in the middle of a flat block.
  for (let x = 0; x < W; x++) {
    if (row[x] === 1) {
      const distance = Math.min(x % 8, 8 - (x % 8));
      assert.ok(distance <= 1, `lit pixel at x=${x} is not near a block boundary`);
    }
  }
});

/* --- hostile inputs ---------------------------------------------------- */

test('a released input buffer is refused, not dereferenced', () => {
  const ramp = run('pattern', [], { kind: 'ramp', width: 4, height: 4 });
  native.bufferRelease(ramp);
  assert.throws(() => run('sobel', [ramp]), /released/);
});

test('non-handles and non-arrays are refused', () => {
  assert.throws(() => run('sobel', [{}]), /buffer handles/);
  assert.throws(() => native.runKernel('sobel', 'nope', {}), /must be an array/);
});

console.log(failures === 0 ? '\nAll kernel tests passed.' : `\n${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
