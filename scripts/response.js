#!/usr/bin/env node
/**
 * A camera's response curve, measured from an exposure bracket: the same
 * still scene shot at several known exposures, nothing else changed. What
 * each 8-bit code means in linear light is the one curve that makes every
 * pixel's light the same in all of them once its exposure is divided out
 * (Debevec and Malik, 1997). Written as the file `load(curve=)` reads --
 * `lab-cli --curve`, `gap-sweep --curve` -- because a contrast curve left in
 * costs four to nine times the gap error, and undone costs nothing
 * (design-lab-model.md §5, "A thirty-sixth").
 *
 *   npm run response -- --out <curve.json> <image>@<exposure> ... [options]
 *
 *   <image>@<exposure>  one shot of the bracket and its exposure, in any
 *                  unit so long as all are in the same one: shutter time
 *                  times gain, say, or 0.25, 0.5, 1, 2. Three or more
 *   --per <n>      pixels sampled per code per shot            (2)
 *   --smooth <x>   how strongly the curve is held smooth, as a share of
 *                  the data's own weight per code             (10)
 *
 * One curve for all three channels, from 8-bit images of one size. The
 * scale is arbitrary -- light is known only up to the exposure's unit -- so
 * code 255 is set to 1; nothing the lab measures depends on a scale. The
 * ends, codes 0 and 255, are clipped light in every shot and carry no data:
 * code 0 is taken to be black, and 255 is the smoothness's extrapolation.
 *
 * **Code 255 cannot be measured, and it matters.** Under a strong S-curve
 * (degrade --scurve 6) the stack's lit faces reach it, the extrapolation is
 * 7-14% low, and that one value is the whole of what a measured curve leaves
 * behind: 0.23 mm, against 0.03 with it set to the truth (design-lab-model.md
 * §5, "A thirty-seventh"). Expose so that what is measured stays below 255.
 *
 * The fit is least squares on log light, each observation weighted by how
 * far its code is from either end (a hat), with a penalty on the second
 * difference. Each sampled pixel's own log light is an unknown, eliminated
 * in closed form, so the system solved is 256 x 256 however many pixels are
 * sampled. A curve that comes out decreasing anywhere is made non-decreasing
 * and the count reported: `load` refuses one that folds back.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { decodePNG } = require('./png');

const usage = 'usage: npm run response -- --out <curve.json> <image>@<exposure> ... [--per <n>] [--smooth <x>]';

function parseArgs(argv) {
  const opts = { out: null, per: 2, smooth: 10, shots: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => { const v = Number(argv[++i]); if (!Number.isFinite(v)) throw new Error(`${a} needs a number`); return v; };
    switch (a) {
      case '--out': opts.out = argv[++i]; break;
      case '--per': opts.per = num(); break;
      case '--smooth': opts.smooth = num(); break;
      case '--help': case '-h': opts.help = true; break;
      default: {
        const at = a.lastIndexOf('@');
        if (a.startsWith('--') || at < 1) throw new Error(`not an <image>@<exposure>: ${a}`);
        const t = Number(a.slice(at + 1));
        if (!(t > 0)) throw new Error(`${a}: the exposure must be a positive number`);
        opts.shots.push({ file: a.slice(0, at), exposure: t });
      }
    }
  }
  if (opts.help) return opts;
  if (!opts.out) throw new Error('--out is required');
  if (opts.shots.length < 3) throw new Error('a bracket is three shots or more');
  if (new Set(opts.shots.map((s) => s.exposure)).size < 2) throw new Error('the shots need different exposures');
  if (!(Number.isInteger(opts.per) && opts.per >= 1)) throw new Error('--per needs a whole number of 1 or more');
  if (!(opts.smooth > 0)) throw new Error('--smooth needs a positive number');
  return opts;
}

/** The hat: no weight at the clipped ends, most in the middle. */
const hat = (z) => (z <= 127 ? z : 255 - z);

/** In-place Cholesky solve of a symmetric positive-definite n x n system (row-major). */
function solveSpd(A, b, n) {
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j];
    for (let k = 0; k < j; k++) d -= A[j * n + k] * A[j * n + k];
    if (!(d > 0)) throw new Error(`response: the system is singular at code ${j} -- too few codes seen in more than one shot`);
    const l = Math.sqrt(d);
    A[j * n + j] = l;
    for (let i = j + 1; i < n; i++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = s / l;
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= A[i * n + k] * y[k];
    y[i] = s / A[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= A[k * n + i] * y[k];
    y[i] = s / A[i * n + i];
  }
  return y;
}

/**
 * The curve from a bracket: `images` as decodePNG gives them, `exposures`
 * beside them. Returns the linear value of each code (255 -> 1) and what the
 * fit saw. Pure, so the tests call it without files.
 */
function measure(images, exposures, { per = 2, smooth = 10 } = {}) {
  const { width, height } = images[0];
  for (const img of images) {
    if (img.width !== width || img.height !== height) throw new Error('response: the shots are not all one size');
    if (img.channels < 3) throw new Error('response: needs RGB or RGBA images');
  }
  const P = images.length, n = width * height;
  const code = (j, i, c) => images[j].data[i * images[j].channels + c];

  // Which pixels: for each shot and each code it holds, `per` of the places
  // it holds it, spread evenly through the image in scan order -- so every
  // code any shot reaches is in the fit, however rare. Deterministic.
  const chosen = new Set();
  for (let j = 0; j < P; j++) {
    const where = Array.from({ length: 256 }, () => []);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) where[code(j, i, c)].push(i * 3 + c);
    for (let z = 1; z < 255; z++) {
      const w = where[z];
      for (let k = 0; k < Math.min(per, w.length); k++) chosen.add(w[Math.floor(((k + 0.5) * w.length) / Math.min(per, w.length))]);
    }
  }
  const samples = [...chosen].sort((a, b) => a - b);

  // The normal equations in g = ln(linear), the per-pixel log light already
  // eliminated: a pixel with weights a_j = w(z_j)^2 couples its codes by
  // a_j a_k / sum(a), and pulls each toward its exposure less their mean.
  const N = 256, S = new Float64Array(N * N), rhs = new Float64Array(N);
  const lnT = exposures.map(Math.log), seen = new Int32Array(N);
  let rows = 0;
  const used = [];
  for (const s of samples) {
    const i = Math.floor(s / 3), c = s % 3;
    const z = [], a = [], t = [];
    for (let j = 0; j < P; j++) {
      const zj = code(j, i, c), w = hat(zj);
      if (w > 0) { z.push(zj); a.push(w * w); t.push(lnT[j]); }
    }
    if (z.length < 2) continue;
    const A = a.reduce((p, q) => p + q, 0), mean = a.reduce((p, q, k) => p + q * t[k], 0) / A;
    for (let k = 0; k < z.length; k++) {
      S[z[k] * N + z[k]] += a[k];
      rhs[z[k]] += a[k] * (t[k] - mean);
      for (let m = 0; m < z.length; m++) S[z[k] * N + z[m]] -= (a[k] * a[m]) / A;
      seen[z[k]]++;
    }
    rows += z.length;
    used.push({ i, c, z, a, t });
  }
  if (used.length === 0) throw new Error('response: no pixel is unclipped in two shots');

  // Smoothness, weighted like the data -- the hat -- and scaled so that
  // `smooth` is its share of the data's weight at a typical code.
  const lambda2 = (smooth * rows) / 254;
  for (let z = 1; z < 255; z++) {
    const w2 = lambda2 * Math.max(hat(z), 1) ** 2, c = [z - 1, z, z + 1], v = [1, -2, 1];
    for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) S[c[p] * N + c[q]] += w2 * v[p] * v[q];
  }
  // Light is known up to a factor: pin g(128) and rescale after.
  S[128 * N + 128] += 1;
  const g = solveSpd(S, rhs, N);

  // How well one curve explains every pixel, in log light.
  let ss = 0, ws = 0;
  for (const { z, a, t } of used) {
    const A = a.reduce((p, q) => p + q, 0);
    const e = a.reduce((p, q, k) => p + q * (g[z[k]] - t[k]), 0) / A;
    for (let k = 0; k < z.length; k++) { ss += a[k] * (g[z[k]] - t[k] - e) ** 2; ws += a[k]; }
  }

  // Code 0 is black. No shot measures below code 1 -- whatever light was
  // there clipped -- and a response curve's foot is at zero light; left to
  // the smoothness it came out at 0.7% of full scale under a strong S-curve.
  // (Suspected, wrongly, of the k = 6 shortfall: the readings did not move.)
  const linear = Array.from(g, (v, z) => (z === 0 ? 0 : Math.exp(v - g[255])));
  let fixed = 0;
  for (let z = 1; z < 256; z++) if (linear[z] < linear[z - 1]) { linear[z] = linear[z - 1]; fixed++; }
  let codesSeen = 0;
  for (let z = 1; z < 255; z++) if (seen[z] > 0) codesSeen++;
  return { linear, pixels: used.length, codesSeen, rmsLog: Math.sqrt(ss / ws), monotoneFixed: fixed };
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(`${err.message}\n${usage}`); process.exit(2); }
  if (opts.help) { console.log(usage); return; }
  const shots = opts.shots.map((s) => {
    const bytes = fs.readFileSync(s.file);
    return { ...s, bytes, image: decodePNG(bytes) };
  });
  const fit = measure(shots.map((s) => s.image), shots.map((s) => s.exposure), opts);
  const record = {
    kind: 'response', method: 'Debevec-Malik, hat-weighted, one curve for R, G and B; linear[255] = 1',
    shots: shots.map((s) => ({ file: path.relative(process.cwd(), path.resolve(s.file)), exposure: s.exposure,
      sha256: crypto.createHash('sha256').update(s.bytes).digest('hex') })),
    per: opts.per, smooth: opts.smooth, pixels: fit.pixels, codesSeen: fit.codesSeen,
    rmsLog: Number(fit.rmsLog.toFixed(6)), monotoneFixed: fit.monotoneFixed,
    linear: fit.linear.map((v) => Number(v.toPrecision(9))),
  };
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${shots.length} shots, ${fit.pixels} pixels, ${fit.codesSeen} of 254 codes seen; `
    + `rms ${fit.rmsLog.toFixed(4)} in log light${fit.monotoneFixed ? `; ${fit.monotoneFixed} codes raised to keep it non-decreasing` : ''}`);
  if (fit.codesSeen < 200) console.log('few codes seen: widen the bracket, or shoot a scene with more tones');
  console.log(`-> ${opts.out}`);
}

if (require.main === module) main();
module.exports = { measure };
