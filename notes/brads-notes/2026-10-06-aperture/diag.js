// Per-pair refit error over gap-sweep runs, split by whether the frame holds a
// ledge (ledge gain >= 1.3) -- the profile's shape against the ledge's ramp.
//   node diag.js <results dir> ...   (each holding pairs/gap-sweep.json)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const rms = (a) => Math.sqrt(mean(a.map((v) => v * v)));
const f3 = (v) => (Number.isFinite(v) ? (v >= 0 ? ' ' : '') + v.toFixed(3) : '   -  ');
const groups = new Map();
for (const dir of process.argv.slice(2)) {
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'pairs', 'gap-sweep.json'), 'utf8'));
  for (const r of run.rows) {
    if (!r.refit || !Number.isFinite(r.refit.errorPx)) continue;
    const ledge = (r.refit.ledge?.gain ?? 0) >= 1.3 ? 'ledge' : 'clean';
    const k = `pair ${r.pair} ${ledge}`;
    if (!groups.has(k)) groups.set(k, { err: [], mov: [], tgt: [] });
    const g = groups.get(k);
    g.err.push(r.refit.errorPx); g.mov.push(r.refit.movingOffsetPx); g.tgt.push(r.refit.targetOffsetPx);
  }
}
console.log('                 n    gap err mean  rms     moving mean  rms     still mean  rms');
for (const [k, g] of [...groups].sort()) {
  console.log(`${k.padEnd(14)} ${String(g.err.length).padStart(4)}   ${f3(mean(g.err))} ${f3(rms(g.err))}    ${f3(mean(g.mov))} ${f3(rms(g.mov))}    ${f3(mean(g.tgt))} ${f3(rms(g.tgt))}`);
}
