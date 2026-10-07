// The gap each view-pair reads at flush, as a line in the lift: from a y
// sweep's tracked readings, no truth.  flushLines(<y run>) -> { "35/20|2": [a, b] }
'use strict';
const fs = require('node:fs'), path = require('node:path');
const R = path.join(__dirname, '../../../');
const { liftOf } = require('./lift');
function flushLines(run) {
  const j = JSON.parse(fs.readFileSync(R + `results/${run}/pairs/gap-sweep.json`, 'utf8'));
  const by = {};
  for (const r of j.rows) {
    if (!r.tracked || !Number.isFinite(r.tracked.gapPx) || r.pair == null) continue;
    (by[`${r.yaw}/${r.elevation}|${r.pair}`] ??= []).push([liftOf(j, r), r.tracked.gapPx]);
  }
  const out = {};
  for (const [k, pts] of Object.entries(by)) {
    if (pts.length < 3) continue;
    const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
    const b = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
    out[k] = [b, my - b * mx];
  }
  return out;
}
module.exports = { flushLines };
if (require.main === module) console.log(flushLines(process.argv[2]));
