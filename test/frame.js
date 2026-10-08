'use strict';

/**
 * Float frames in: `frame()`, the vision package's input contract for a
 * renderer's linear light, and the PFM files cv-lab keeps them in.
 *
 *   node test/frame.js
 */

const assert = require('node:assert/strict');

const { decodePfm, encodePfm } = require('../packages/vision/src/pfm.js');
const { Session } = require('../packages/vision/src/session.js');
const { createLabRegistry, native } = require('../src/lab-host');

let failures = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

/**
 * A bright rectangle on a dark ground, in linear light, turned `turn` degrees
 * about its centre, each pixel the average of 8 x 8 samples of what it covers
 * -- what a converged path tracer gives for a sharp edge. Pixel (x, y) covers
 * [x, x+1) x [y, y+1).
 */
function rectangle({ size = 64, left = 20.3, right = 43.7, top = 18.6, bottom = 45.2, turn = 0,
                     ground = 0.05, bright = 0.8, channels = 3 } = {}) {
  const [cx, cy] = [(left + right) / 2, (top + bottom) / 2];
  const [c, s] = [Math.cos(turn * Math.PI / 180), Math.sin(turn * Math.PI / 180)];
  const inside = (x, y) => {
    const u = cx + (x - cx) * c + (y - cy) * s, v = cy - (x - cx) * s + (y - cy) * c;
    return u >= left && u < right && v >= top && v < bottom;
  };
  const data = new Float32Array(size * size * channels);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) n += inside(x + (i + 0.5) / 8, y + (j + 0.5) / 8);
      const f = n / 64;
      for (let k = 0; k < channels; k++) data[(y * size + x) * channels + k] = k === 3 ? 1 : ground + f * (bright - ground);
    }
  }
  return { width: size, height: size, channels, data };
}

const frames = new Map();
const registry = createLabRegistry({ readFrame: async (source) => {
  if (!frames.has(source)) throw new Error(`no frame "${source}"`);
  return frames.get(source);
} });
const session = () => new Session({ registry });

const PIPELINE = `
G = gray(A)
B = gaussian(G, sigma=1.4)
Gx = sobel(B, axis=x)
Gy = sobel(B, axis=y)
M = sobel(B, axis=mag)
N = nms(M, Gx, Gy)
S = segments(N, Gx, Gy)
R = merge(S)
F = fit(R)`;

/** The long segments' lines, each as its angle and its distance from the origin, in a fixed order. */
async function sides(source) {
  const s = session();
  await s.run(`A = frame(${JSON.stringify(source)})${PIPELINE}`);
  return s.slots.get('F').value.features.filter((f) => f.length > 10).map((f) => {
    const [dx, dy] = [(f.x1 - f.x0) / f.length, (f.y1 - f.y0) / f.length];
    return { vertical: Math.abs(dy) > Math.abs(dx), rho: f.x0 * dy - f.y0 * dx };
  }).sort((a, b) => a.vertical - b.vertical || a.rho - b.rho);
}

console.log('cv-lab-2 float frame tests');

test('a PFM file round-trips, rows bottom-up on disk and top-down in the frame', () => {
  const frame = rectangle({ size: 7, channels: 3 });
  const bytes = encodePfm(frame);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 11)), 'PF\n7 7\n-1.0');
  const back = decodePfm(bytes);
  assert.deepEqual([back.width, back.height, back.channels], [7, 7, 3]);
  assert.deepEqual(back.data, frame.data);
  // The first samples written are the BOTTOM row's.
  const view = new DataView(bytes.buffer, bytes.byteOffset + 12);
  assert.equal(view.getFloat32(0, true), frame.data[6 * 7 * 3]);
});

test('a big-endian PFM (positive scale) and a one-channel one decode', () => {
  const header = new TextEncoder().encode('Pf\n2 1\n1.0\n');
  const bytes = new Uint8Array(header.length + 8);
  bytes.set(header);
  const view = new DataView(bytes.buffer, header.length);
  view.setFloat32(0, 0.25, false);
  view.setFloat32(4, 3.5, false);
  const f = decodePfm(bytes);
  assert.equal(f.channels, 1);
  assert.deepEqual([...f.data], [0.25, 3.5]);
});

test('a malformed PFM is refused by what is wrong with it', () => {
  const ok = encodePfm(rectangle({ size: 4 }));
  assert.throws(() => decodePfm(ok.subarray(0, ok.length - 4)), /needs 192 bytes of samples, the file has 188/);
  assert.throws(() => decodePfm(new TextEncoder().encode('P6\n4 4\n255\n')), /not PF or Pf/);
  assert.throws(() => decodePfm(new TextEncoder().encode('PF\n4 -4\n-1\n')), /not two positive integers/);
  assert.throws(() => decodePfm(new TextEncoder().encode('PF\n4')), /header ends/);
});

test('frame() gives the host\'s samples to the bit, linear, and RGBA\'s alpha is dropped', async () => {
  frames.set('rgb', rectangle());
  frames.set('rgba', rectangle({ channels: 4 }));
  const s = session();
  await s.run('A = frame("rgb")\nB = frame("rgba")');
  const [a, b] = ['A', 'B'].map((k) => s.slots.get(k).value.handle);
  assert.deepEqual(native.bufferRead(a), frames.get('rgb').data);
  assert.equal(native.bufferInfo(a).space, 'linear');
  assert.equal(native.bufferHash(a), native.bufferHash(b));
  const [ea, eb] = s.toJSON().entries;
  assert.equal(ea.output.hash, eb.output.hash);
  assert.deepEqual(ea.record.params, { source: 'rgb' });
});

test('light above 1 survives: a frame twice as bright places every side where it was', async () => {
  frames.set('dim', rectangle({ turn: 6, bright: 0.8 }));
  frames.set('bright', rectangle({ turn: 6, bright: 1.6, ground: 0.1 }));
  const dim = await sides('dim');
  const bright = await sides('bright');
  assert.equal(dim.length, 4, `four sides, got ${JSON.stringify(dim)}`);
  assert.deepEqual(bright.map((s) => s.vertical), dim.map((s) => s.vertical));
  bright.forEach(({ rho }, k) => assert.ok(Math.abs(rho - dim[k].rho) < 1e-4, `side ${k}: ${rho} against ${dim[k].rho}`));
});

test('a NaN, an infinity, a negative sample, one channel or a short array is refused, not repaired', async () => {
  const bad = (edit, extra = {}) => { const f = { ...rectangle({ size: 8 }), ...extra }; f.data = Float32Array.from(f.data); edit(f.data); return f; };
  frames.set('nan', bad((d) => { d[30] = NaN; }));
  frames.set('inf', bad((d) => { d[5] = Infinity; }));
  frames.set('neg', bad((d) => { d[3 * 9] = -1e-3; }));
  frames.set('mono', { width: 8, height: 8, channels: 1, data: new Float32Array(64) });
  frames.set('short', { width: 8, height: 8, channels: 3, data: new Float32Array(100) });
  const fails = async (source, pattern) => {
    await assert.rejects(session().run(`A = frame("${source}")`), pattern);
  };
  await fails('nan', /frame: nan: sample NaN at \(2, 1\)/);
  await fails('inf', /sample Infinity at \(1, 0\)/);
  await fails('neg', /sample -0\.001\d* at \(1, 1\); a frame is finite, non-negative light/);
  await fails('mono', /1 channel\(s\); a frame is RGB or RGBA/);
  await fails('short', /needs a Float32Array of 192 samples/);
  await assert.rejects(session().run('A = frame()'), /source is required/);
});

test('a session replays from its frames, and a different frame under the same name is caught', async () => {
  frames.set('shot', rectangle());
  const s = session();
  await s.run(`A = frame("shot")${PIPELINE}`);
  const saved = s.toJSON();
  assert.deepEqual((await Session.replay(saved, { registry })).mismatches, []);
  frames.set('shot', rectangle({ left: 20.4 }));
  const { mismatches } = await Session.replay(saved, { registry });
  assert.equal(mismatches[0]?.n, 1, 'the frame itself is the first entry to differ');
});

test('without a frame reader, frame() is declared and not implemented', () => {
  const { createRegistry } = require('../packages/vision/src/ops.js');
  assert.equal(createRegistry({ backend: native }).get('frame').implemented, false);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
  }
  console.log(failures === 0 ? '\nAll float frame tests passed.' : `\n${failures} failing.`);
  process.exit(failures === 0 ? 0 : 1);
})();
