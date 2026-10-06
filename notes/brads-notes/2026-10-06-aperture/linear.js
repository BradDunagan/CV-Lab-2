// What a calibration cannot take out: per view and pair, the refit gap fitted
// as a straight line in the true gap, over a sweep's frames; the RMS of what
// is left, pooled. Frames with a ledge are left out (the hinge's business).
//   node linear.js <results dir> ...
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const groups = new Map();
for (const dir of process.argv.slice(2)) {
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'pairs', 'gap-sweep.json'), 'utf8'));
  for (const r of run.rows) {
    if (!r.refit || !Number.isFinite(r.refit.gapPx) || (r.refit.ledge?.gain ?? 0) >= 1.3) continue;
    const k = `${dir}|${r.yaw}/${r.elevation}|${r.pair}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push([r.trueGapPx, r.refit.gapPx]);
  }
}
const left = { 1: [], 2: [] };
for (const [k, pts] of groups) {
  if (pts.length < 4) continue;
  const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  const sxx = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0), sxy = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  const b = sxy / sxx;
  for (const p of pts) left[k.split('|')[2]].push(p[1] - my - b * (p[0] - mx));
}
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
console.log(`not linear in the true gap, px rms: pair 1 ${rms(left[1]).toFixed(3)} (${left[1].length})  pair 2 ${rms(left[2]).toFixed(3)} (${left[2].length})`);
