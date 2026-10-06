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
 *   --seed <n>                                                        (1)
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
const opts = { k1: 0, blur: 0, gain: 0, read: 0, gamma: 0, seed: 1 };
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i].replace(/^--/, '');
  if (!(k in opts)) { console.error(`unknown option ${rest[i]}`); process.exit(2); }
  opts[k] = Number(rest[i + 1]);
}
if (!src || !dst) { console.error('usage: npm run degrade -- <generated/run> <generated/new-run> [options]'); process.exit(2); }
for (const k of Object.keys(opts)) if (!Number.isFinite(opts[k])) { console.error(`--${k} needs a number`); process.exit(2); }
if (!fs.existsSync(path.join(src, 'shots.json'))) { console.error(`${src} is not a generated run: no shots.json`); process.exit(2); }

const toLinear = (u) => { const v = u / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const toSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

let seed = opts.seed >>> 0;
const uniform = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());

/** Every channel but alpha, in linear light; RGB or RGBA in, RGBA out. */
function degrade({ width: w, height: h, channels: nc, data: rgba }) {
  if (nc < 3) throw new Error('degrade: needs an RGB or RGBA image');
  const out = Buffer.alloc(w * h * 4);
  for (let ch = 0; ch < 3; ch++) {
    let img = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) img[i] = toLinear(rgba[i * nc + ch]);
    if (opts.k1) {
      const d = new Float64Array(w * h), cx = (w - 1) / 2, cy = (h - 1) / 2, s = w / 2;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const nx = (x - cx) / s, ny = (y - cy) / s, f = 1 + opts.k1 * (nx * nx + ny * ny);
        const sx = cx + nx * f * s, sy = cy + ny * f * s;
        const x0 = Math.max(0, Math.min(w - 2, Math.floor(sx))), y0 = Math.max(0, Math.min(h - 2, Math.floor(sy)));
        const fx = sx - x0, fy = sy - y0;
        d[y * w + x] = img[y0 * w + x0] * (1 - fx) * (1 - fy) + img[y0 * w + x0 + 1] * fx * (1 - fy)
          + img[(y0 + 1) * w + x0] * (1 - fx) * fy + img[(y0 + 1) * w + x0 + 1] * fx * fy;
      }
      img = d;
    }
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
      const e = opts.gamma ? v ** (1 / opts.gamma) : toSrgb(v);
      out[i * 4 + ch] = Math.round(e * 255);
    }
  }
  for (let i = 0; i < w * h; i++) out[i * 4 + 3] = nc === 4 ? rgba[i * 4 + 3] : 255;
  return out;
}

fs.mkdirSync(dst, { recursive: true });
for (const name of fs.readdirSync(src)) {
  const from = path.join(src, name), to = path.join(dst, name);
  if (name.endsWith('.png')) {
    const img = decodePNG(fs.readFileSync(from));
    fs.writeFileSync(to, encodePNG(img.width, img.height, degrade(img)));
  } else fs.cpSync(from, to, { recursive: true });
}
fs.writeFileSync(path.join(dst, 'degraded.json'), `${JSON.stringify({ from: src, ...opts }, null, 2)}\n`);
console.log(`${dst}: ${JSON.stringify(opts)}`);
