// Each gap reading from the PNG route against the float route, on the same
// renders: per run, the RMS of each route's error against the truth (px), and
// the RMS of their difference. Rows matched by view, pair and shot.
//   node compare.js [suffix]        (default -f)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '../../..');
const suffix = process.argv[2] ?? '-f';
const rms = (v) => (v.length ? Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length) : NaN);
const f = (v) => v.toFixed(3).padStart(7);
console.log('run      column    n    png err  float err  difference  max |diff|');
for (const r of ['x', 'y', 'z', 'turn', 'test']) {
  const dir = path.join(ROOT, 'results', `stack-2g-${r}${suffix}`, 'pairs');
  const read = (d) => JSON.parse(fs.readFileSync(path.join(d, 'gap-sweep.json'), 'utf8')).rows;
  const key = (row) => `${row.yaw}/${row.elevation}/${row.pair}/${row.pose ?? row.gapMm}`;
  const png = new Map(read(dir).map((row) => [key(row), row]));
  const flt = read(path.join(dir, 'float'));
  for (const col of ['refit', 'tracked']) {
    const a = [], b = [], d = [];
    for (const row of flt) {
      const p = png.get(key(row));
      const ep = p?.[col]?.errorPx, ef = row[col]?.errorPx;
      if (!Number.isFinite(ep) || !Number.isFinite(ef)) continue;
      a.push(ep); b.push(ef); d.push(ef - ep);
    }
    console.log(`${r.padEnd(8)} ${col.padEnd(8)} ${String(d.length).padStart(4)} ${f(rms(a))}   ${f(rms(b))}    ${f(rms(d))}    ${f(Math.max(...d.map(Math.abs)))}`);
  }
}
