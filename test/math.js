'use strict';

/**
 * The vision package's own math (packages/vision/src/math.js): close to the
 * engine's, equal to the C's where they share a function, and the only math
 * the package uses.
 *
 *   node test/math.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let failures = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

/** Units in the last place between two doubles. */
const view = new DataView(new ArrayBuffer(16));
function ulps(a, b) {
  if (Object.is(a, b)) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  view.setFloat64(0, a); view.setFloat64(8, b);
  const d = view.getBigInt64(0) - view.getBigInt64(8);
  return Number(d < 0n ? -d : d);
}

/** The LCG the C reference uses, in BigInt: its products overflow a double's 53 bits. */
function lcg(seed) {
  let s = BigInt(seed);
  return () => { s = (s * 1103515245n + 12345n) % 2147483648n; return Number(s) / 2147483648; };
}

console.log('cv-lab-2 math tests');

(async () => {
  const m = await import('../packages/vision/src/math.js');

  test('each function is within 4 ULP of the engine\'s, over the ranges the package uses', () => {
    const cases = {
      len2: [(a, b) => [a * 2000 - 1000, b * 2000 - 1000], Math.hypot],
      len3: [(a, b) => [a - 0.5, b - 0.5, a * b], Math.hypot],
      atan2: [(a, b) => [a * 2 - 1, b * 2 - 1], Math.atan2],
      asin: [(a) => [a * 2 - 1], Math.asin],
      acos: [(a) => [a * 2 - 1], Math.acos],
      sin: [(a) => [a * 40 - 20], Math.sin],
      cos: [(a) => [a * 40 - 20], Math.cos],
      tan: [(a) => [a * 3 - 1.5], Math.tan],
      log: [(a, b) => [10 ** (a * 40 - 20) * (b + 0.5)], Math.log],
    };
    for (const [name, [args, engine]] of Object.entries(cases)) {
      const r = lcg(7);
      let worst = 0;
      for (let i = 0; i < 20000; i++) {
        const x = args(r(), r());
        worst = Math.max(worst, ulps(m[name](...x), engine(...x)));
      }
      assert.ok(worst <= 4, `${name}: ${worst} ULP from the engine's`);
    }
  });

  test('their edges: zeros, ends, signs and what is not a number', () => {
    assert.equal(m.atan2(0, 0), 0);
    assert.equal(m.atan2(0, -1), Math.PI);
    assert.equal(m.atan2(-1, 0), -Math.PI / 2);
    assert.equal(m.acos(1), 0);
    assert.equal(m.acos(-1), Math.PI);
    assert.equal(m.asin(1), Math.PI / 2);
    assert.ok(Number.isNaN(m.acos(1.0000001)) && Number.isNaN(m.asin(-2)));
    assert.equal(m.sin(0), 0); assert.ok(Object.is(m.sin(-0), -0));
    assert.equal(m.cos(0), 1); assert.equal(m.tan(0), 0);
    assert.ok(Number.isNaN(m.sin(Infinity)) && Number.isNaN(m.cos(NaN)) && Number.isNaN(m.tan(-Infinity)));
    assert.equal(m.log(1), 0);
    assert.equal(m.log(0), -Infinity);
    assert.ok(Number.isNaN(m.log(-1)) && Number.isNaN(m.log(NaN)));
    assert.equal(m.log(Infinity), Infinity);
    assert.ok(ulps(m.log(5e-324), Math.log(5e-324)) <= 1, 'the smallest subnormal');
    assert.ok(ulps(m.log(Number.MAX_VALUE), Math.log(Number.MAX_VALUE)) <= 1);
    assert.equal(m.sq(-3), 9);
  });

  test('atan2 is the C\'s cv_atan2 to the bit', () => {
    // From native/kernels.c, compiled with -ffp-contract=off: FNV-1a over the
    // bytes of 100,000 results on the LCG's pairs in [-1, 1]^2, and five
    // fixed ones. Where the C and the JavaScript reach the same angle, they
    // agree on purpose (design-lab-model.md §5, rule 3b).
    const r = lcg(99);
    let h = 1469598103934665603n;
    const bytes = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 100000; i++) {
      const y = r() * 2 - 1, x = r() * 2 - 1;
      bytes.setFloat64(0, m.atan2(y, x), true);
      for (let k = 0; k < 8; k++) { h ^= BigInt(bytes.getUint8(k)); h = (h * 1099511628211n) & 0xffffffffffffffffn; }
    }
    assert.equal(h.toString(16).padStart(16, '0'), 'd86e60e30788831a');
    assert.equal(m.atan2(1, 1), 0.78539816339744839);
    assert.equal(m.atan2(-0.5, -2), -2.8966139904629289);
    assert.equal(m.atan2(3e-9, -7), 3.1415926531612217);
    assert.equal(m.atan2(1, -1e-300), 1.5707963267948966);
    assert.equal(m.atan2(0.25, 0.75), 0.32175055439664224);
  });

  test('the package calls no engine-approximated math, but the render plan', () => {
    // ECMAScript leaves these to the implementation; + - * / and sqrt it does not.
    const approximated = /Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot)\b|\*\*\s*[\w(]/;
    const dir = path.join(__dirname, '..', 'packages', 'vision', 'src');
    const found = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'math.js')) {
      // LF: a Windows checkout's CRLF leaves a \r that hides a comment's end.
      let source = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
      // gapsweep.js's orbitViews places a renderer's camera: recorded in
      // shots.json and checked against those bytes, so it keeps the engine's.
      if (file === 'gapsweep.js') source = source.replace(/function orbitViews\([\s\S]*?\n}\n/, '');
      source.split('\n').forEach((line, k) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (approximated.test(code)) found.push(`${file}:${k + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(found, []);
  });

  for (const [name, fn] of queue) {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
  }
  console.log(failures === 0 ? '\nAll math tests passed.' : `\n${failures} failing.`);
  process.exit(failures === 0 ? 0 : 1);
})();
