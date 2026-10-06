// The aperture fitted on the pair itself, in frames where the gap is wide:
// fitBand with the aperture free, under each profile, per view and pair.
//   node wide.js <run> [minGapPx]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { decodePNG } = require('../../../scripts/png');
const P = require('../../../src/lab/pairs');
const toLinear = (u) => { const v = u / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const [run, minGap = 3.5] = process.argv.slice(2);
const sweep = JSON.parse(fs.readFileSync(path.join('results', run, 'pairs', 'gap-sweep.json'), 'utf8'));
const opts = { ...P.DEFAULTS };
const out = { box: [], smooth: [] };
for (const row of sweep.rows) {
  if (row.refit?.from !== 'pair' || !(row.refit.gapPx >= Number(minGap)) || (row.refit.ledge?.gain ?? 0) >= 1.3) continue;
  const { width, height, channels: nc, data } = decodePNG(fs.readFileSync(path.join('generated', run, row.shot)));
  const g = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) g[i] = 0.2126 * toLinear(data[i * nc]) + 0.7152 * toLinear(data[i * nc + 1]) + 0.0722 * toLinear(data[i * nc + 2]);
  const raster = { width, height, channels: 1, data: g };
  const slots = JSON.parse(fs.readFileSync(path.join('results', run, 'pairs', row.shot.replace('.png', '.features.json')), 'utf8'));
  const rec = slots.find((s) => s.slot === 'P').features.find((p) => p.id === row.refit.pair);
  const F = slots.find((s) => s.slot === 'F').features;
  const { frames } = P.candidates(F, opts);
  const frame = frames.find((f) => f.edges[0].id === rec.a.segment && f.edges[1].id === rec.b.segment);
  if (!frame) continue;
  const s = P.bandSamples(raster, frame, opts);
  const line = [`${row.yaw}/${row.elevation} p${row.pair} ${row.gapMm}mm ${row.trueGapPx.toFixed(2)}px`];
  for (const profile of ['box', 'smooth']) {
    const f = P.fitBand(s, frame, { aperture: rec.aperture, fitAperture: true, slopedLevels: true, profile });
    if (f) { out[profile].push(f.aperture); line.push(`${profile} ${f.aperture.toFixed(3)} gap err ${(f.edges[1].c - f.edges[0].c - rec.gap + row.refit.errorPx).toFixed(3)}`); }
  }
  console.log(line.join('   '));
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
console.log(`median: box ${med(out.box).toFixed(3)} smooth ${med(out.smooth).toFixed(3)} (n ${out.smooth.length})`);
