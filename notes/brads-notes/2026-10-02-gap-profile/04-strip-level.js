'use strict';

/**
 * Does the strip keep its level as the gap closes?
 *
 *   node 04-strip-level.js <run> [results subdirectory]
 *   node 04-strip-level.js gap-1-front-2048 pairs
 *
 * Holding the strip's level from a wide frame assumes it does. At 512 px
 * nothing can say below 2 mm, because no pixel is wholly inside the strip. At
 * 2048 px the same 1 mm gap is 4.6 px wide and the level can be read off the
 * pixels in its middle, with no model at all.
 *
 * For each frame: the truth pair, then every pixel of the band along it, at
 * its own distance h from the Table's truth edge and with the local true gap
 * g. "Core" is the pixels at least `MARGIN` px inside both edges -- clear of
 * any pixel that mixes in a neighbour. Printed: the core's mean, and the
 * strip's profile in tenths of its width, to see whether it is flat.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const repo = path.resolve(__dirname, '..', '..', '..');
const { truthPair, line, DEFAULTS } = require(path.join(repo, 'src/lab/gapsweep'));

const MARGIN = 1.0;

/** 8-bit RGBA PNG -> linear luminance, as load(as=linear) then gray. */
function decodeGray(file) {
  const b = fs.readFileSync(file);
  let p = 8, w = 0, h = 0; const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    else if (type === 'IDAT') idat.push(data);
    p += len + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const u = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + u;
      else if (f === 3) v = x + ((a + u) >> 1);
      else { const pa = Math.abs(u - c), pb = Math.abs(a - c), pc = Math.abs(a + u - 2 * c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c); }
      out[y * stride + i] = v & 255;
    }
  }
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.2126 * lin(out[4 * i]) + 0.7152 * lin(out[4 * i + 1]) + 0.0722 * lin(out[4 * i + 2]);
  return { width: w, height: h, channels: 1, data: g };
}


const [run, sub = ''] = process.argv.slice(2);
const dir = path.join(repo, 'results', run, sub);
const frames = fs.readdirSync(dir).filter((f) => f.endsWith('.features.json'))
  .map((f) => f.replace('.features.json', ''))
  .sort((p, q) => Number(q.slice(4).replace('mm', '').replace('p', '.')) - Number(p.slice(4).replace('mm', '').replace('p', '.')));

for (const name of frames) {
  const gapMm = Number(name.slice(4).replace('mm', '').replace('p', '.'));
  const lists = JSON.parse(fs.readFileSync(path.join(dir, `${name}.features.json`), 'utf8'));
  const T = lists.find((s) => s.slot === 'T').features;
  const pair = truthPair(T, 'Cube', 'Table', gapMm / 1000, DEFAULTS);
  if (!pair || !(pair.facing.gap > 0)) { console.log(`${name}: no gap`); continue; }
  const img = decodeGray(path.join(repo, 'generated', run, `${name}.png`));
  const a = line(pair.a), b = line(pair.b);
  const { normal: n, lo, hi } = pair.facing;
  const u = b.u;
  const gapAt = (t) => {
    const q = [b.p0[0] + u[0] * t, b.p0[1] + u[1] * t];
    const det = a.u[0] * -n[1] - a.u[1] * -n[0];
    const r = [q[0] - a.p0[0], q[1] - a.p0[1]];
    return (a.u[0] * r[1] - a.u[1] * r[0]) / det;
  };
  // Clear of the Cube's own corners at both ends of the overlap.
  const t0 = lo + 0.08 * (hi - lo), t1 = hi - 0.08 * (hi - lo);
  const xs = [b.p0[0] + u[0] * t0, b.p0[0] + u[0] * t1], ys = [b.p0[1] + u[1] * t0, b.p0[1] + u[1] * t1];
  const R = pair.facing.gap + 12;
  const core = [], below = [], above = [];
  const tenths = Array.from({ length: 10 }, () => ({ sum: 0, n: 0 }));
  for (let y = Math.max(0, Math.floor(Math.min(...ys) - R)); y <= Math.min(img.height - 1, Math.ceil(Math.max(...ys) + R)); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(...xs) - R)); x <= Math.min(img.width - 1, Math.ceil(Math.max(...xs) + R)); x++) {
      const r = [x - b.p0[0], y - b.p0[1]];
      const t = r[0] * u[0] + r[1] * u[1];
      if (t < t0 || t > t1) continue;
      const h = r[0] * n[0] + r[1] * n[1];
      const g = gapAt(t);
      const v = img.data[y * img.width + x];
      if (h < -3 && h > -9) below.push(v);
      if (h > g + 3 && h < g + 9) above.push(v);
      if (h >= MARGIN && h <= g - MARGIN) {
        core.push(v);
        const k = Math.min(9, Math.floor((h / g) * 10));
        tenths[k].sum += v; tenths[k].n++;
      }
    }
  }
  const mean = (v) => (v.length ? v.reduce((p, q) => p + q, 0) / v.length : NaN);
  const sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map((x) => (x - m) ** 2))); };
  console.log(`${name.padEnd(9)} gap ${pair.facing.gap.toFixed(2).padStart(6)} px  table front ${mean(below).toFixed(3)}  cube face ${mean(above).toFixed(3)}  `
    + (core.length ? `strip core ${mean(core).toFixed(3)} (sd ${sd(core).toFixed(3)}, ${core.length} px)` : `strip core: no pixel ${MARGIN} px inside both edges`));
  if (core.length) {
    console.log('          across the strip, Table side to Cube side: '
      + tenths.map((b) => (b.n ? (b.sum / b.n).toFixed(3) : '  -  ')).join(' '));
  }
}
