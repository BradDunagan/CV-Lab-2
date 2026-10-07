// The calibration's own residual per view-pair, from a solve's JSON: what a
// camera with no truth can see.   node calrms.js <solve.json> ...
'use strict';
const rms = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);
for (const f of process.argv.slice(2)) {
  const j = require(require('node:path').resolve(f));
  const by = new Map();
  for (const c of j.calibrated) {
    if (!Number.isFinite(c.calibration?.rms)) continue;
    const k = c.key.replace(/ \/ end.*/, '').replace('yaw ', '').replace(', elev ', '/').replace(' / pair ', '|');
    (by.get(k) ?? by.set(k, []).get(k)).push(c.calibration.rms);
  }
  const all = [...by.values()].flat();
  console.log(f.split('/').pop().padEnd(26), 'all', rms(all).toFixed(4), [...by].map(([k, v]) => `${k} ${rms(v).toFixed(3)}`).join('  '));
}
