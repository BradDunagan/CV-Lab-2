'use strict';

/**
 * Determinism — design-lab-model.md §5.
 *
 * §5 makes two claims the rest of the project leans on: that a result is
 * bit-reproducible within a machine, and — with `-ffp-contract=off` — across
 * platforms too. The second is the load-bearing one, because content hashes
 * are how a replay says "this kernel changed", and a hash that differs by
 * platform makes that signal meaningless.
 *
 * Neither claim was checked anywhere. The flag was written down as decided in
 * §5 and §9, and never reached `binding.gyp`; the arm64 build was contracting
 * `a*b + c` into 167 single-rounding FMA instructions that baseline x86-64
 * does not have, so macOS and the Windows and Linux runners were computing
 * genuinely different last bits. Nothing failed, because nothing looked.
 *
 * So this suite hardcodes hashes, which everywhere else in this project would
 * be the wrong kind of test — CLAUDE.md says to assert properties, not current
 * output. The exception is deliberate and §5 sanctions it directly ("a stored
 * script plus expected hashes is a test case"): the property under test is
 * "this exact value, on every platform, forever", and a literal is the only
 * way to write that down. It is also why this suite has to run on all three
 * CI machines to mean anything. Passing here alone proves nothing — that is
 * the whole lesson of `scripts/lint-native.js`.
 *
 * If a hash below changes, exactly one of two things happened:
 *
 *   1. A kernel's behaviour changed. Bump its `version` in the registry and
 *      update the expectation here, in the same commit, with the reason.
 *   2. The build stopped being deterministic. Check `-ffp-contract=off`
 *      survived, and look for a reduction that lost its fixed summation order.
 *
 * A mismatch on ONE platform while the others agree is case 2, always.
 *
 *   node test/determinism.js
 */

const assert = require('node:assert/strict');

const native = require('../native');
const { createRegistry } = require('../src/lab/ops');
const { Session } = require('../src/lab/session');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

console.log('cv-lab-2 determinism tests');
console.log(`  (${process.platform}/${process.arch}, node ${process.versions.node})`);

/*
 * One script, exercising every kernel whose arithmetic could drift: the
 * Gaussian's tap accumulation, three Sobel convolutions, the sRGB transfer
 * function, the TLS running sums inside `segments` and `merge`, and the
 * tiled reduction in `stats`.
 *
 * `pattern` rather than a file, so this needs no image and no decoder and
 * therefore runs under plain node on all three runners.
 *
 * minPixels=3 because `pattern(kind=checker)` draws 8-pixel blocks, and after
 * a sigma=1.4 blur and non-maximum suppression no run of one survives the
 * default of 8 — the whole pipeline would return empty and every hash below
 * would be the hash of nothing, passing for the wrong reason.
 */
const SCRIPT = `
// A ramp for the colour chain, NOT the checkerboard. A checker holds only 0
// and 1, and both transfer functions map those to themselves exactly — so the
// first version of this script produced identical hashes for the buffer
// before and after toSrgb, and would have gone on passing with the sRGB curve
// deleted entirely. A ramp puts a distinct value in every column.
P  = pattern(kind=ramp, width=64, height=64, channels=3)
L  = toSrgb(P)
Q  = toLinear(L)
G  = gray(Q)

// A checkerboard for the geometry chain, which needs edges to find.
A  = pattern(kind=checker, width=64, height=64, channels=1)
B  = gaussian(A, sigma=1.4)
Gx = sobel(B, axis=x)
Gy = sobel(B, axis=y)
M  = sobel(B, axis=mag)
N  = nms(M, Gx, Gy)
H  = hysteresis(N, low=0.002, high=0.01)
O  = orient(Gx, Gy)
S  = segments(N, Gx, Gy, minPixels=3)
R  = merge(S)
F  = fit(R)
C  = corners(F)
stats(B)
`;

/*
 * Expected output hashes, by slot. Produced by this script on arm64 macOS
 * with -ffp-contract=off; the point of the CI matrix is that x86-64 Windows
 * and Linux reproduce them exactly.
 */
const EXPECTED = {
  P:  '025376eb900a3bd0651ec18be5d4dee324444796dc022beea9c4f91155195c97',
  L:  '4f0a1d0542a6cf38f9804e350f01ab33fa1b10e3a7c35099dacb1b8c895e58f1',
  Q:  '61e7181acf6fad0d5883cfeb5cfd6f72f46d34cc982f54fd81a3ac790ea0cc0a',
  G:  '977e3ec2dfb65f3a8fd820a24cff807061b0c85db9b96b9aaafea23588a80dc9',
  A:  '1319cc04dc7688f0ceba9c71e4cf311c5235cc981f766621de2d808371358737',
  B:  '18060bbb2a5f1496599e3517fa36be15435ff82267da5bd4ef59aa0717a6b114',
  Gx: '6f65f6f1f47de58efe29568e394e87e0f8ecd1735418ef7d765afdaac5a5720a',
  Gy: 'b932b50b0d000de4dfd4ca78915d009d63f6180abbecfc97b82cce2b26212e5e',
  M:  'addc231dea36fe2e7169331a253db2f64810c84775a85c3440ad53a69babdaad',
  N:  '808eb429711a0a09f4649c5fdb661a09563c0c4f8a12feb0216d1997383f5776',
  H:  'cbf14b18d9552b1620b905185f5e8da2be7932e6e1adae786702744c9d9f4a27',
  O:  '9fa4f0f7174fc5ac8c24acd324c85008b0e34fbdccc8e2c0f084f0f51f0da066',
  S:  'cad811d4931d3573a356aecfe9952f793ee9796920b1a14b5ffcdfdd25100f6d',
  R:  '90375302cc7012f3e9bc77cf728b84efcb0663db7db207d2f62d6583a03c0190',
  F:  '1d6a71e3d8061df7075152c39cb4081624427bae8677f9220c9254cf3557b080',
  C:  '61ede2c01953485baa597a95191547757f4142b0d3491454e1e42c80c831e662',
};

async function run() {
  const session = new Session({ registry: createRegistry() });
  await session.run(SCRIPT);
  return session;
}

(async () => {
  const session = await run();

  await test('every stage of the pipeline produces its recorded hash', () => {
    const actual = {};
    for (const entry of session.log) {
      if (entry.produced) actual[entry.produced.slot] = entry.output.hash;
    }
    const drifted = [];
    for (const [slot, expected] of Object.entries(EXPECTED)) {
      if (expected === null) continue;      // not yet pinned
      if (actual[slot] !== expected) {
        drifted.push(`${slot}: expected ${expected}\n         got      ${actual[slot]}`);
      }
    }
    assert.equal(drifted.length, 0, `\n       ${drifted.join('\n       ')}`);
  });

  await test('the pipeline is not silently empty', () => {
    // Guards every other assertion here: hashes of nothing agree on every
    // platform too, and would make this whole suite pass for the wrong reason.
    const features = session.log.filter((e) => e.output.kind === 'features');
    assert.equal(features.length, 2, 'expected fit and corners to both run');
    for (const entry of features) {
      assert.ok(entry.output.count > 0, `${entry.text} produced no features`);
    }
  });

  await test('re-running the same script gives the same hashes', async () => {
    // Within one machine and one build: the cheap half of §5, and the half
    // that catches an accidental dependence on allocation addresses or on
    // iteration order over a hash map.
    const again = await run();
    const before = session.log.map((e) => e.output.hash);
    const after = again.log.map((e) => e.output.hash);
    assert.deepEqual(after, before);
  });

  await test('two routes to a linear value agree exactly — §5 rule 4', () => {
    /*
     * `load(as=linear)` narrows to f32 before applying the transfer function
     * so that it lands on the same value `toLinear` reaches from an f32
     * buffer. They differed by one ULP on about half the byte values until
     * that was made deliberate. Checked here on every byte rather than on a
     * sample, since it is exactly 256 cases.
     */
    const rgba = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      rgba[i * 4] = i; rgba[i * 4 + 1] = i; rgba[i * 4 + 2] = i; rgba[i * 4 + 3] = 255;
    }
    const direct = native.bufferFromRGBA8(rgba, 256, 1, { from: 'srgb', as: 'linear' });
    const asSrgb = native.bufferFromRGBA8(rgba, 256, 1, { from: 'srgb', as: 'srgb' });
    const converted = native.runKernel('toLinear', [asSrgb], {});

    const a = native.bufferRead(direct);
    const b = native.bufferRead(converted);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      assert.ok(Object.is(a[i], b[i]),
        `byte ${Math.floor(i / 3)}: load gave ${a[i]}, toLinear gave ${b[i]}`);
    }
    for (const h of [direct, asSrgb, converted]) native.bufferRelease(h);
  });

  await test('the reduction in stats does not depend on tile boundaries', () => {
    /*
     * §5 rule 1. `stats` accumulates per fixed-size tile and combines tiles in
     * ascending order, so that moving it onto the thread pool later cannot
     * change the answer. What that buys is checked here the only way it can be
     * from outside: the same data, laid out at two widths that put the tile
     * boundaries in different places, must sum identically.
     */
    const values = new Float32Array(4096);
    for (let i = 0; i < values.length; i++) values[i] = Math.sin(i * 0.37) * 0.5 + 0.5;

    const wide = native.createBuffer({ width: 4096, height: 1, channels: 1, dtype: 'f32' });
    const tall = native.createBuffer({ width: 64, height: 64, channels: 1, dtype: 'f32' });
    native.bufferWrite(wide, values);
    native.bufferWrite(tall, values);

    const a = native.runKernel('stats', [wide], {});
    const b = native.runKernel('stats', [tall], {});
    assert.deepEqual(b, a);

    native.bufferRelease(wide);
    native.bufferRelease(tall);
  });

  /* --- reporting ------------------------------------------------------- */

  const unpinned = Object.entries(EXPECTED).filter(([, v]) => v === null).map(([k]) => k);
  if (unpinned.length > 0) {
    const actual = {};
    for (const entry of session.log) {
      if (entry.produced) actual[entry.produced.slot] = entry.output.hash;
    }
    console.error(`\n  ${unpinned.length} slot(s) have no pinned hash. Paste into EXPECTED:\n`);
    for (const slot of Object.keys(EXPECTED)) {
      console.error(`    ${slot}: '${actual[slot]}',`);
    }
    console.error('');
    failures++;
  }

  console.log(failures === 0
    ? '\nAll determinism tests passed.'
    : `\n${failures} determinism test(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
