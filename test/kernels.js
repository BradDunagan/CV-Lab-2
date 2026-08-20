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
    ['pattern', 'gray', 'gaussian', 'sobel', 'threshold', 'stats']);
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
