// What one frame per view says about a light, before any sweep: each pair's
// refit at the reference pose (the turn sweep's middle, 4 mm up, unturned).
//   node cheap.js
'use strict';
const R = require('node:path').join(__dirname, '../../../results/');
const LIGHTS = [['45/5', 'stack-2g', 'good'], ['45/10', 'stack-l4g', 'good'], ['45/20', 'stack-l1g', 'warned'], ['42/45', 'stack-4g', 'warned'],
  ['60/5', 'stack-l5g', 'NOT warned'], ['70/6', 'stack-3g', 'NOT warned'], ['15/10', 'stack-l2g', 'warned'], ['-30/10', 'stack-l3g', 'warned']];
const f = (v, d = 3) => (v == null || !Number.isFinite(v) ? '   -  ' : v.toFixed(d).padStart(6));
for (const [light, pre, verdict] of LIGHTS) {
  const j = require(`${R}${pre}-turn/pairs/gap-sweep.json`);
  console.log(`${light.padEnd(7)} ${verdict}`);
  for (const r of j.rows.filter((r) => /pose-3\.png$/.test(r.shot) && r.pair != null).sort((a, b) => a.shot.localeCompare(b.shot) || a.pair - b.pair)) {
    const x = r.refit ?? {};
    console.log(`   ${r.yaw}/${r.elevation} pair ${r.pair}  gap ${f(x.gapPx)}  sigma ${f(x.gapSigma)}  strip ${f(x.stripLevel)}  ledge ${f(x.ledge?.gain)} ${x.ledge?.edge ?? ' '}  ends ${x.endsPx ? f(x.endsPx[0] - x.endsPx[1]) : '   -  '}   (truth err ${f(x.errorPx)})`);
  }
}
