#!/usr/bin/env node
/**
 * A rendered run made to look more like a camera's: lens distortion, optical
 * blur, sensor noise and a response curve the lab does not undo. Written as
 * a new generated/ run beside the original, its shots, truth and AOV passes
 * copied, so `gap-sweep --skip-render` analyses it as it would a render --
 * the renderer's images varied the way a real camera varies them, without
 * rendering again (design-lab-model.md §5, "A twenty-fourth").
 *
 *   npm run degrade -- <generated/run> <generated/new-run> [options]
 *
 *   --k1 <x>       radial distortion, r normalised to half the width: an
 *                  output pixel shows the scene at r(1 + k1 r^2)     (0)
 *   --blur <px>    Gaussian sigma of the optics                       (0)
 *   --gain <e>     electrons at full scale: shot noise sd sqrt(v/gain) (off)
 *   --read <x>     read noise sd, as a fraction of full scale         (0)
 *   --gamma <g>    encode with v^(1/g) instead of sRGB; the lab decodes
 *                  sRGB, so this is a response curve left in          (off)
 *   --scurve <k>   and then a filmic S-curve on the encoded value, a
 *                  tanh of strength k about mid-grey: 0, 0.5 and 1 stay,
 *                  the middle steepens k/(2 tanh(k/2)) times and the ends
 *                  flatten -- a camera's "contrast" setting           (off)
 *   --seed <n>                                                        (1)
 *   --interp <k>   how the distortion resamples: bilinear, or cubic
 *                  (Catmull-Rom). Bilinear blurs: it adds a sixth of a
 *                  pixel squared of spread, which took the measured
 *                  aperture from 1.35 to 2.0 px. Catmull-Rom reproduces a
 *                  quadratic and adds none to that order     (bilinear)
 *   --downsample <f>  the run was rendered f times larger: distort at that
 *                  size, then average f x f blocks down to it; the truth's
 *                  pixel coordinates and the AOV passes are scaled to
 *                  match. Blur, noise and the curve are applied after, at
 *                  the output size                                   (1)
 *
 * Applied in that order, in linear light, per colour channel; alpha is kept.
 *
 * The truth is NOT distorted: a position solve is scored against the pose,
 * and a calibration from the readings never looks at the image truth. What
 * still reads it -- where along a pair the gap is measured, and which track
 * speaks for which pair -- has 3 px of slack.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { encodePNG, decodePNG } = require('./png');

const [src, dst, ...rest] = process.argv.slice(2);
const opts = { k1: 0, blur: 0, gain: 0, read: 0, gamma: 0, scurve: 0, seed: 1, interp: 'bilinear', downsample: 1 };
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i].replace(/^--/, '');
  if (!(k in opts)) { console.error(`unknown option ${rest[i]}`); process.exit(2); }
  opts[k] = k === 'interp' ? rest[i + 1] : Number(rest[i + 1]);
}
if (!['bilinear', 'cubic'].includes(opts.interp)) { console.error('--interp is bilinear or cubic'); process.exit(2); }
if (!(Number.isInteger(opts.downsample) && opts.downsample >= 1)) { console.error('--downsample needs a whole number'); process.exit(2); }
if (!src || !dst) { console.error('usage: npm run degrade -- <generated/run> <generated/new-run> [options]'); process.exit(2); }
for (const k of Object.keys(opts)) if (k !== 'interp' && !Number.isFinite(opts[k])) { console.error(`--${k} needs a number`); process.exit(2); }
if (!fs.existsSync(path.join(src, 'shots.json'))) { console.error(`${src} is not a generated run: no shots.json`); process.exit(2); }

const toLinear = (u) => { const v = u / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const toSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** The S-curve on an encoded value in [0, 1]; the identity at strength 0. */
const sCurve = (e) => (opts.scurve > 0 ? 0.5 + 0.5 * Math.tanh(opts.scurve * (e - 0.5)) / Math.tanh(opts.scurve / 2) : e);

let seed = opts.seed >>> 0;
const uniform = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());

/** Catmull-Rom weights for a sample at fraction t past the second of four. */
const cubicWeights = (t) => [
  ((-t + 2) * t - 1) * t / 2, ((3 * t - 5) * t * t + 2) / 2, ((-3 * t + 4) * t + 1) * t / 2, (t - 1) * t * t / 2];

/** The image at (sx, sy), between its pixels. */
function sample(img, w, h, sx, sy) {
  if (opts.interp === 'bilinear') {
    const x0 = Math.max(0, Math.min(w - 2, Math.floor(sx))), y0 = Math.max(0, Math.min(h - 2, Math.floor(sy)));
    const fx = sx - x0, fy = sy - y0;
    return img[y0 * w + x0] * (1 - fx) * (1 - fy) + img[y0 * w + x0 + 1] * fx * (1 - fy)
      + img[(y0 + 1) * w + x0] * (1 - fx) * fy + img[(y0 + 1) * w + x0 + 1] * fx * fy;
  }
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  const wx = cubicWeights(sx - x0), wy = cubicWeights(sy - y0);
  let acc = 0;
  for (let j = 0; j < 4; j++) {
    const yy = Math.max(0, Math.min(h - 1, y0 - 1 + j));
    for (let i = 0; i < 4; i++) acc += img[yy * w + Math.max(0, Math.min(w - 1, x0 - 1 + i))] * wx[i] * wy[j];
  }
  return acc;
}

/** f x f blocks averaged. */
function shrink(img, w, h, f) {
  const W = Math.floor(w / f), H = Math.floor(h / f), out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) acc += img[(y * f + j) * w + x * f + i];
    out[y * W + x] = acc / (f * f);
  }
  return out;
}

/** Every channel but alpha, in linear light; RGB or RGBA in, RGBA out (shrunk by --downsample). */
function degrade({ width: W0, height: H0, channels: nc, data: rgba }) {
  if (nc < 3) throw new Error('degrade: needs an RGB or RGBA image');
  const f = opts.downsample, w = Math.floor(W0 / f), h = Math.floor(H0 / f);
  const out = Buffer.alloc(w * h * 4);
  for (let ch = 0; ch < 3; ch++) {
    let img = new Float64Array(W0 * H0);
    for (let i = 0; i < W0 * H0; i++) img[i] = toLinear(rgba[i * nc + ch]);
    if (opts.k1) {
      // At the size rendered, in pixel-centre coordinates; r is normalised
      // to half the width whatever the size, so k1 means one thing.
      const d = new Float64Array(W0 * H0), cx = (W0 - 1) / 2, cy = (H0 - 1) / 2, s = W0 / 2;
      for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) {
        const nx = (x - cx) / s, ny = (y - cy) / s, g = 1 + opts.k1 * (nx * nx + ny * ny);
        d[y * W0 + x] = sample(img, W0, H0, cx + nx * g * s, cy + ny * g * s);
      }
      img = d;
    }
    if (f > 1) img = shrink(img, W0, H0, f);
    if (opts.blur) {
      const r = Math.ceil(3 * opts.blur), k = [];
      for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * opts.blur * opts.blur)));
      const sum = k.reduce((a, b) => a + b, 0);
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const t = new Float64Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          let acc = 0;
          for (let i = -r; i <= r; i++) {
            const xx = Math.max(0, Math.min(w - 1, x + i * dx)), yy = Math.max(0, Math.min(h - 1, y + i * dy));
            acc += img[yy * w + xx] * k[i + r];
          }
          t[y * w + x] = acc / sum;
        }
        img = t;
      }
    }
    for (let i = 0; i < w * h; i++) {
      let v = img[i];
      const sd = Math.sqrt((opts.gain ? Math.max(v, 0) / opts.gain : 0) + opts.read * opts.read);
      if (sd > 0) v += gauss() * sd;
      v = Math.max(0, Math.min(1, v));
      const e = sCurve(opts.gamma ? v ** (1 / opts.gamma) : toSrgb(v));
      out[i * 4 + ch] = Math.round(e * 255);
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(y * w + x) * 4 + 3] = nc === 4 ? rgba[(y * f * W0 + x * f) * 4 + 3] : 255;
  return { width: w, height: h, data: out };
}

/**
 * An AOV pass shrunk by --downsample: one pixel of each f x f block, not their
 * mean -- the depth pass is pt-lab's fixed-point depth packed into the bytes,
 * and a mean of packed bytes is not a depth. explain samples them a few
 * pixels either side of an edge, so the 1/(2f) px this leaves is immaterial.
 */
function shrinkPass({ width: W0, height: H0, channels: nc, data }) {
  const f = opts.downsample, w = Math.floor(W0 / f), h = Math.floor(H0 / f), out = Buffer.alloc(w * h * 4);
  const o = Math.floor(f / 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = ((y * f + o) * W0 + x * f + o) * nc;
    for (let c = 0; c < 4; c++) out[(y * w + x) * 4 + c] = c < nc ? data[k + c] : 255;
  }
  return { width: w, height: h, data: out };
}

/** A truth file's pixel coordinates, in corner convention, divided by f. */
function shrinkTruth(doc, f) {
  doc.size /= f;
  for (const e of doc.edges) { e.x0 /= f; e.y0 /= f; e.x1 /= f; e.y1 /= f; e.length /= f; }
  for (const v of doc.vertices) { v.x /= f; v.y /= f; }
  return doc;
}

fs.mkdirSync(dst, { recursive: true });
for (const name of fs.readdirSync(src)) {
  const from = path.join(src, name), to = path.join(dst, name);
  if (name.endsWith('.png')) {
    const img = degrade(decodePNG(fs.readFileSync(from)));
    fs.writeFileSync(to, encodePNG(img.width, img.height, img.data));
  } else if (opts.downsample > 1 && name.endsWith('.gt.json')) {
    fs.writeFileSync(to, `${JSON.stringify(shrinkTruth(JSON.parse(fs.readFileSync(from, 'utf8')), opts.downsample))}\n`);
  } else if (opts.downsample > 1 && name === 'aov') {
    fs.mkdirSync(to, { recursive: true });
    for (const pass of fs.readdirSync(from)) {
      const img = shrinkPass(decodePNG(fs.readFileSync(path.join(from, pass))));
      fs.writeFileSync(path.join(to, pass), encodePNG(img.width, img.height, img.data));
    }
  } else fs.cpSync(from, to, { recursive: true });
}
fs.writeFileSync(path.join(dst, 'degraded.json'), `${JSON.stringify({ from: src, ...opts }, null, 2)}\n`);
console.log(`${dst}: ${JSON.stringify(opts)}`);
