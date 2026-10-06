// Carried (trackPair) reading error per pair over gap-sweep runs: mean, RMS,
// and the RMS of what is not linear in the true gap per view and pair.
//   node tracked.js <results dir> ...
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const groups = new Map();
for (const dir of process.argv.slice(2)) {
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'pairs', 'gap-sweep.json'), 'utf8'));
  for (const r of run.rows) {
    if (!r.tracked || !Number.isFinite(r.tracked.gapPx)) continue;
    const k = `${dir}|${r.yaw}/${r.elevation}|${r.pair}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push([r.trueGapPx, r.tracked.gapPx - r.trueGapPx]);
  }
}
const by = { 1: { all: [], left: [] }, 2: { all: [], left: [] } };
for (const [k, pts] of groups) {
  const g = by[k.split('|')[2]];
  g.all.push(...pts.map((p) => p[1]));
  if (pts.length < 3) continue;
  const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  const sxx = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const b = sxx > 0 ? pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx : 0;
  for (const p of pts) g.left.push(p[1] - my - b * (p[0] - mx));
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length, rms = (a) => Math.sqrt(mean(a.map((v) => v * v)));
const f = (v) => v.toFixed(3);
console.log(`${process.argv.slice(2).join(' ').replace(/results\/stack-2g-/g, '')}:  pair 1 n ${by[1].all.length} mean ${f(mean(by[1].all))} rms ${f(rms(by[1].all))} nonlin ${f(rms(by[1].left))}   pair 2 n ${by[2].all.length} mean ${f(mean(by[2].all))} rms ${f(rms(by[2].all))} nonlin ${f(rms(by[2].left))}`);
