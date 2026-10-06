// Every lone segment of some frames fitted as one step under each profile:
// the aperture each says, and how well each fits (rms), side by side.
//   node lone.js <run> <shot.png> ...      e.g. lone.js stack-2g-x-blur y35-e20-gap-2mm.png
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { decodePNG } = require('../../../scripts/png');
const P = require('../../../src/lab/pairs');
const toLinear = (u) => { const v = u / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const [run, ...shots] = process.argv.slice(2);
const opts = { ...P.DEFAULTS };
const rows = [];
for (const shot of shots) {
  const png = decodePNG(fs.readFileSync(path.join('generated', run, shot)));
  const { width, height, channels: nc, data } = png;
  const g = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) g[i] = 0.2126 * toLinear(data[i * nc]) + 0.7152 * toLinear(data[i * nc + 1]) + 0.0722 * toLinear(data[i * nc + 2]);
  const raster = { width, height, channels: 1, data: g };
  const feats = JSON.parse(fs.readFileSync(path.join('results', run, 'pairs', shot.replace('.png', '.features.json')), 'utf8'));
  const F = feats.find((s) => s.slot === 'F').features.filter((f) => f.type === 'segment' || f.x0 !== undefined);
  const { segs, paired } = P.candidates(F, opts);
  for (const seg of segs) {
    if (paired.has(seg.id)) continue;
    const frame = P.loneFrame(seg, opts);
    if (!frame || 2 * frame.half < 20) continue;
    const s = P.bandSamples(raster, frame, opts);
    const r = {};
    for (const profile of ['box', 'smooth']) {
      const f = P.fitBand(s, frame, { aperture: 1, fitAperture: true, profile });
      r[profile] = f && f.converged ? f : null;
    }
    if (r.box && r.smooth) rows.push({ shot, id: seg.id, len: 2 * frame.half, step: Math.abs(r.box.levels[1] - r.box.levels[0]), box: r.box, smooth: r.smooth });
  }
}
const f3 = (v) => v.toFixed(3);
console.log('shot                       id   len  step   box: ap   rms/step   smooth: ap  rms/step');
for (const r of rows) console.log(`${r.shot.padEnd(26)} ${String(r.id).padStart(3)} ${r.len.toFixed(0).padStart(5)} ${f3(r.step)}   ${f3(r.box.aperture)}  ${f3(r.box.rms / r.step)}      ${f3(r.smooth.aperture)}  ${f3(r.smooth.rms / r.step)}`);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
console.log(`median aperture box ${f3(med(rows.map((r) => r.box.aperture)))} smooth ${f3(med(rows.map((r) => r.smooth.aperture)))}; smooth fits better on ${rows.filter((r) => r.smooth.rms < r.box.rms).length}/${rows.length}`);
