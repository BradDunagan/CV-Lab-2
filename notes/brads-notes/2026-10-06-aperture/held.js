// The front and side pairs of a sweep refitted under a given profile and
// aperture, against truth: each frame's fitPairs record found again by its two
// segments, its gap moved by what the variant changes. Ledge frames left out.
//   node held.js <run> <profile> <aperture | fit> [pair]
// Prints mean and RMS error, and the RMS of what is not linear in the true gap.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { decodePNG } = require('../../../scripts/png');
const P = require('../../../src/lab/pairs');
const toLinear = (u) => { const v = u / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const [run, profile, ap, pairArg] = process.argv.slice(2);
const sweep = JSON.parse(fs.readFileSync(path.join('results', run, 'pairs', 'gap-sweep.json'), 'utf8'));
const errs = new Map(); const rasters = new Map();
const rasterOf = (shot) => {
  if (rasters.has(shot)) return rasters.get(shot);
  const { width, height, channels: nc, data } = decodePNG(fs.readFileSync(path.join('generated', run, shot)));
  const g = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) g[i] = 0.2126 * toLinear(data[i * nc]) + 0.7152 * toLinear(data[i * nc + 1]) + 0.0722 * toLinear(data[i * nc + 2]);
  const r = { raster: { width, height, channels: 1, data: g }, slots: JSON.parse(fs.readFileSync(path.join('results', run, 'pairs', shot.replace('.png', '.features.json')), 'utf8')) };
  rasters.set(shot, r); return r;
};
const variants = new Map();
for (const row of sweep.rows) {
  if (row.refit?.from !== 'pair' || (row.refit.ledge?.gain ?? 0) >= 1.3) continue;
  if (pairArg && String(row.pair) !== pairArg) continue;
  const { raster, slots } = rasterOf(row.shot);
  const rec = slots.find((s) => s.slot === 'P').features.find((p) => p.id === row.refit.pair);
  if (!rec) continue;
  if (!variants.has(row.shot)) {
    const F = slots.find((s) => s.slot === 'F').features;
    variants.set(row.shot, P.fitPairs(F, raster, ap === 'fit' ? { profile } : { profile, aperture: 'held', apertureWidth: Number(ap) }));
  }
  const v = variants.get(row.shot).find((p) => p.a.segment === rec.a.segment && p.b.segment === rec.b.segment);
  const k = `${row.yaw}/${row.elevation}/${row.pair}`;
  if (!errs.has(k)) errs.set(k, []);
  errs.get(k).push(v ? [row.trueGapPx, row.refit.errorPx + v.gap - rec.gap] : [row.trueGapPx, null]);
}
const all = [], left = []; let lost = 0;
for (const pts0 of errs.values()) {
  const pts = pts0.filter((p) => p[1] !== null); lost += pts0.length - pts.length;
  all.push(...pts.map((p) => p[1]));
  if (pts.length < 4) continue;
  const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  const b = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  for (const p of pts) left.push(p[1] - my - b * (p[0] - mx));
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length, rms = (a) => Math.sqrt(mean(a.map((v) => v * v)));
console.log(`${run} ${profile} ${ap}${pairArg ? ' pair ' + pairArg : ''}: n ${all.length} (lost ${lost})  mean ${mean(all).toFixed(3)}  rms ${rms(all).toFixed(3)}  not linear ${rms(left).toFixed(3)}`);
