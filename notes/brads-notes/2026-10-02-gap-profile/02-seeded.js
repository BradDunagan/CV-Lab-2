'use strict';

/**
 * What `fitPairs` reads where the pipeline detects no pair: 1 mm and 0.5 mm.
 *
 *   node 02-seeded.js
 *
 * The two facing TRUTH edges are handed to it as if they were detections,
 * each pushed 0.3 px away from the other, together with the image's real
 * segments away from the gap so the aperture has lone segments to be measured
 * on. Then the same with the strip's level held at 0.123, the value the 5 mm
 * frames fit. Prints the rows quoted in ../2026-10-02.md.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const repo = path.resolve(__dirname, '..', '..', '..');
const { fitPairs } = require(path.join(repo, 'src/lab/pairs'));
const { truthPair, DEFAULTS } = require(path.join(repo, 'src/lab/gapsweep'));

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

const f = (v) => (v >= 0 ? '+' : '') + v.toFixed(3);
for (const run of ['gap-1-front-linear', 'gap-1-front-linear-2']) {
  for (const g of ['2', '1', '0p5']) {
    const name = `gap-${g}mm`;
    const lists = JSON.parse(fs.readFileSync(path.join(repo, 'results', run, `${name}.features.json`), 'utf8'));
    const slot = (n) => lists.find((s) => s.slot === n).features;
    const tp = truthPair(slot('T'), 'Cube', 'Table', Number(g.replace('p', '.')) / 1000, DEFAULTS);
    const raster = decodeGray(path.join(repo, 'generated', run, `${name}.png`));
    const n = tp.facing.normal;
    const push = (e, k, id) => ({ type: 'edge-segment', id,
      x0: e.x0 + n[0] * k, y0: e.y0 + n[1] * k, x1: e.x1 + n[0] * k, y1: e.y1 + n[1] * k });
    // The image's own segments, away from the gap, renumbered clear of 1 and 2.
    const elsewhere = slot('F')
      .filter((s) => Math.hypot(s.cx - tp.facing.at[0], s.cy - tp.facing.at[1]) > 60)
      .map((s) => ({ ...s, id: s.id + 100 }));
    const segs = [push(tp.a, 0.3, 1), push(tp.b, -0.3, 2), ...elsewhere];
    for (const [label, o] of [['strip fitted', {}], ['strip held', { strip: 'held', stripLevel: 0.123 }]]) {
      const p = fitPairs(segs, raster, o).find((q) => q.a.segment < 3 && q.b.segment < 3);
      console.log(`${run.padEnd(21)} ${name.padEnd(9)} ${label.padEnd(12)} ` + (p
        ? `gap ${p.gap.toFixed(3)} (true ${tp.facing.gap.toFixed(3)}, error ${f(p.gap - tp.facing.gap)}) ±${p.gapSigma.toFixed(3)}  strip ${p.levels[1].toFixed(3)}  aperture ${p.aperture.toFixed(2)} from ${p.apertureSegments} ${p.apertureFrom}`
        : 'no record'));
    }
  }
}
