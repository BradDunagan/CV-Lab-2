// The ledge's shadow per mm of lift, per view and pair, from free ledge fits
// over the given runs: node kappa.js <out.json> <run> ...
// Kept: frames whose ledge is in sight and fits 1.5x better than the strip alone.
'use strict';
const fs = require('node:fs');
const { retrack } = require('./retrack');
const { liftOf } = require('./lift');
const [out, ...runs] = process.argv.slice(2);
const by = {};
for (const run of runs) {
  const sweep = JSON.parse(fs.readFileSync(`${__dirname}/../../../results/${run}/pairs/gap-sweep.json`, 'utf8'));
  for (const r of retrack(run, { ledge: 'fit' })) {
    const L = r.ledge;
    if (!L || !L.seen || !(L.gain >= 1.5) || r.pair === null) continue;
    const lift = liftOf(sweep, r);
    const k = `${r.view}|${r.pair}`;
    (by[k] ??= []).push({ run, shot: r.shot, lift, offset: L.offset, width: L.width, gain: L.gain, kappa: L.offset / lift, omega: L.width / lift });
  }
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
const table = {};
for (const [k, v] of Object.entries(by)) {
  table[k] = { kappa: median(v.map((x) => x.kappa)), omega: median(v.map((x) => x.omega)), of: v.length, frames: v };
  console.log(k.padEnd(10), `kappa ${table[k].kappa.toFixed(3)} omega ${table[k].omega.toFixed(3)} of ${v.length}:`,
    v.map((x) => `${x.shot.replace('.png', '')}@${x.lift}:${x.kappa.toFixed(2)}/${x.omega.toFixed(2)}`).join(' '));
}
fs.writeFileSync(out, JSON.stringify(table, null, 1));
