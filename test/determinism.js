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
 * The flag alone was not enough, and finding that out is what this suite is
 * for. With it in place the matrix still produced THREE different hashes for
 * `fit` -- and Linux and Windows disagreed with EACH OTHER, on identical
 * hardware with identical flags, which no compiler flag could explain. The
 * cause was libm: IEEE 754 requires +, -, *, / and sqrt to be correctly
 * rounded and says nothing about atan2, cos or hypot, so glibc, Apple's libm
 * and MSVC's UCRT disagree in the last bits. The geometry path no longer calls
 * any of them; see kernels.h.
 *
 * Why only `fit` and `corners` showed it: every buffer narrows to f32 on the
 * way out, which absorbs a last-bit difference in a double. Feature records
 * hash full-precision doubles and do not. The divergence was therefore
 * invisible everywhere except where this lab claims sub-pixel accuracy.
 *
 * If a hash below changes, exactly one of two things happened:
 *
 *   1. A kernel's behaviour changed. Bump its `version` in the registry and
 *      update the expectation here, in the same commit, with the reason.
 *   2. The build stopped being deterministic. Check `-ffp-contract=off`
 *      survived, look for a reduction that lost its fixed summation order, and
 *      look for a libm call that crept back into the geometry.
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
  P: '025376eb900a3bd0651ec18be5d4dee324444796dc022beea9c4f91155195c97',
  L: '4f0a1d0542a6cf38f9804e350f01ab33fa1b10e3a7c35099dacb1b8c895e58f1',
  Q: '61e7181acf6fad0d5883cfeb5cfd6f72f46d34cc982f54fd81a3ac790ea0cc0a',
  G: '977e3ec2dfb65f3a8fd820a24cff807061b0c85db9b96b9aaafea23588a80dc9',
  A: '1319cc04dc7688f0ceba9c71e4cf311c5235cc981f766621de2d808371358737',
  B: '18060bbb2a5f1496599e3517fa36be15435ff82267da5bd4ef59aa0717a6b114',
  Gx: '6f65f6f1f47de58efe29568e394e87e0f8ecd1735418ef7d765afdaac5a5720a',
  Gy: 'b932b50b0d000de4dfd4ca78915d009d63f6180abbecfc97b82cce2b26212e5e',
  M: 'addc231dea36fe2e7169331a253db2f64810c84775a85c3440ad53a69babdaad',
  N: '808eb429711a0a09f4649c5fdb661a09563c0c4f8a12feb0216d1997383f5776',
  H: 'cbf14b18d9552b1620b905185f5e8da2be7932e6e1adae786702744c9d9f4a27',
  O: '9fa4f0f7174fc5ac8c24acd324c85008b0e34fbdccc8e2c0f084f0f51f0da066',
  S: 'cad811d4931d3573a356aecfe9952f793ee9796920b1a14b5ffcdfdd25100f6d',
  R: '90375302cc7012f3e9bc77cf728b84efcb0663db7db207d2f62d6583a03c0190',
  F: 'f44b87efe4279132323139eb85d7b82e29216257619b1c6645a4b925d5042619',
  C: '2cdce86a2f4ad52beb5f0c094cb2678742a610d701f0de781170b171d93e51a0',
};

/*
 * The curve stages' hashes, produced the same way and on the same machine as
 * EXPECTED above. `chain`'s is over the raw i32 label map rather than a slot
 * hash, because this fixture does not go through a Session.
 */
const EXPECTED_CURVES = {
  chain: 'e60b18a107d8619e30ff27181e881d81e7c14de9c6413aaf67d96c646470a228',
  arcs: '074247795a62595f6c75f14079c3bdd5971f2a26c14d28433c24350201bbd287',
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

  /* --- the curve stages ------------------------------------------------ */

  /*
   * `chain` and `fitArcs` are not in the script above, and cannot be: the
   * fixture has to be a CURVE, and `pattern` draws ramps, checkers, impulses
   * and constants. A blurred impulse does produce a ring, but a faint one --
   * the whole pipeline then hangs off a `minMag` near 1e-4, and the test would
   * be measuring the blur's tail rather than the geometry.
   *
   * So the label map is built here instead, by the midpoint circle algorithm:
   * integers and comparisons only, no trigonometry, no floating point at all.
   * The fixture is therefore identical on every platform by construction,
   * which is the one property it has to have -- a fixture that itself differed
   * across the matrix would make this test report a divergence it caused.
   *
   * What is pinned is the hash of the `edge-arc` list, and that is the point:
   * feature records hash full-precision DOUBLES, with nothing narrowing to f32
   * on the way out. That is precisely where `-ffp-contract=off` and libm split
   * `fit` three ways, and it is where these stages would split too.
   */
  await test('the curve stages reproduce their recorded hashes', () => {
    const { hashFeatures } = require('../src/lab/session');
    const native = require('../native');

    /*
     * A circle of radius 40, cut into sixteen pieces of about 22 degrees --
     * roughly what `segments` leaves of a curve once maxResidual and angleTol
     * have each capped how long a piece can be. `chain` joins them back into
     * four arcs of 85 degrees, so both stages do real work: a fixture that
     * `chain` declined to touch would pin `fitArcs` and nothing else.
     *
     * The sub-octant split tests y*5 <= x*2, which is the 21.8 degree line
     * expressed without a tangent. Everything here is integer arithmetic and
     * comparisons.
     */
    const W = 112, H = 112, R = 40, CX = 56, CY = 56;
    const labels = new Int32Array(W * H);
    const SYM = [[1, 1, 0], [1, 1, 1], [-1, 1, 1], [-1, 1, 0],
                 [-1, -1, 0], [-1, -1, 1], [1, -1, 1], [1, -1, 0]];
    {
      let x = R, y = 0, err = 1 - R;
      while (x >= y) {
        const sub = (y * 5 <= x * 2) ? 0 : 1;
        // A break either side of every boundary, so the pieces do not touch.
        const atBreak = Math.abs(y * 5 - x * 2) <= 2 || Math.abs(x - y) <= 1 || y <= 1;
        if (!atBreak) {
          SYM.forEach(([sx, sy, swap], octant) => {
            const px = swap ? y : x, py = swap ? x : y;
            const gx = CX + sx * px, gy = CY + sy * py;
            if (gx < 0 || gy < 0 || gx >= W || gy >= H) return;
            labels[gy * W + gx] = octant * 2 + sub + 1;
          });
        }
        y += 1;
        if (err < 0) err += 2 * y + 1;
        else { x -= 1; err += 2 * (y - x) + 1; }
      }
    }

    const handle = native.createBuffer({ width: W, height: H, channels: 1, dtype: 'i32' });
    native.bufferWrite(handle, labels);
    const chained = native.runKernel('chain', [handle], {});
    const arcs = native.fitArcs(chained);

    /*
     * Guards the hashes below. A hash of nothing agrees on every platform, and
     * so does a hash of a fixture neither stage changed -- which is how a
     * determinism test passes for the wrong reason.
     */
    let pieces = 0;
    for (const v of native.bufferRead(chained)) if (v > pieces) pieces = v;
    assert.equal(pieces, 4, `chain should join sixteen pieces into four, got ${pieces}`);
    assert.equal(arcs.length, 4, `expected four arcs, got ${arcs.length}`);
    assert.ok(arcs.every((a) => a.sweep > 60), 'an arc spans too little to be worth hashing');
    // The circle is four-fold symmetric, so the four fits must agree exactly.
    // A difference here would be an asymmetry in the fit, not in the fixture.
    assert.equal(new Set(arcs.map((a) => a.r)).size, 1,
      'four symmetric arcs produced different radii');

    const actual = {
      chain: require('node:crypto').createHash('sha256')
        .update(Buffer.from(native.bufferRead(chained).buffer)).digest('hex'),
      arcs: hashFeatures(arcs, null),
    };
    if (EXPECTED_CURVES.chain === null || EXPECTED_CURVES.arcs === null) {
      console.error('\n  curve hashes are unpinned. Paste into EXPECTED_CURVES:\n');
      for (const [k, v] of Object.entries(actual)) console.error(`    ${k}: '${v}',`);
      console.error('');
      throw new Error('unpinned');
    }
    assert.equal(actual.chain, EXPECTED_CURVES.chain, 'chain label map');
    assert.equal(actual.arcs, EXPECTED_CURVES.arcs, 'fitArcs feature list');
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
