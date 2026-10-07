// Rows whose tracked gap differs by more than 0.05 px between two variants of
// one run.   node diffrows.js <run-a> <run-b>   (results/<run>/pairs)
'use strict';
const R = require('node:path').join(__dirname, '../../../results/');
const [ra, rb] = process.argv.slice(2);
const a = require(`${R}${ra}/pairs/gap-sweep.json`), b = require(`${R}${rb}/pairs/gap-sweep.json`);
const f = (v) => (Array.isArray(v) ? v : [v]);
a.rows.forEach((r, i) => {
  const s = b.rows[i];
  if (r.tracked?.gapPx == null || s.tracked?.gapPx == null) return;
  const A = f(r.tracked.gapPx), B = f(s.tracked.gapPx);
  const d = Math.max(...A.map((v, k) => Math.abs(v - B[k])));
  if (!(d > 0.05)) return;
  const l = (x) => (x ? `w ${x.width?.toFixed(2)} gain ${x.gain?.toFixed(4)} seen ${x.seen}` : '-');
  console.log(`${d.toFixed(3).padStart(7)} ${r.shot.padEnd(28)} pair ${r.pair}  ${A.map((v) => v.toFixed(3))} -> ${B.map((v) => v.toFixed(3))}   [${l(r.ledge)}] -> [${l(s.ledge)}]`);
});
