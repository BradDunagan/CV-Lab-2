// How far the held ledge moves each tracked gap from the plain fit's:
//   node shift.js <suffix> [threshold]   (stack-2g-<run><suffix> against -plain)
'use strict';
const R = require('node:path').join(__dirname, '../../../results/');
const [suffix, th = '0.3'] = process.argv.slice(2);
const runs = ['x', 'y', 'z', 'turn', 'test', 'test-r2', 'test-r3', 'test-low'];
const f = (v) => (Array.isArray(v) ? v : [v]);
const ds = [];
for (const blur of ['', '-blur']) for (const r of runs) {
  let a, b;
  try { a = require(`${R}stack-2g-${r}${blur}-plain/pairs/gap-sweep.json`); b = require(`${R}stack-2g-${r}${blur}${suffix}/pairs/gap-sweep.json`); } catch { continue; }
  a.rows.forEach((x, i) => {
    const y = b.rows[i];
    if (x.tracked?.gapPx == null || y.tracked?.gapPx == null || !y.ledge) return;
    const A = f(x.tracked.gapPx), B = f(y.tracked.gapPx);
    A.forEach((v, k) => ds.push({ d: B[k] - v, shot: `${r}${blur}:${x.shot}:${x.pair}`, gain: y.ledge.gain, offset: y.ledge.offset, plain: v,
      ep: x.tracked.errorPx, el: y.tracked.errorPx }));
  });
}
ds.sort((p, q) => p.d - q.d);
const q = (p) => ds[Math.floor(p * (ds.length - 1))].d.toFixed(3);
console.log(`${suffix}: n ${ds.length}  min ${q(0)} 1% ${q(0.01)} 5% ${q(0.05)} 50% ${q(0.5)} 95% ${q(0.95)} 99% ${q(0.99)} max ${q(1)}`);
for (const x of ds.filter((x) => Math.abs(x.d) > Number(th)))
  console.log(`  ${x.d.toFixed(3).padStart(7)} ${x.shot.padEnd(36)} plain ${x.plain.toFixed(3)} offset ${x.offset.toFixed(2)} gain ${x.gain.toFixed(4)}  err ${x.ep?.toFixed(3)} -> ${x.el?.toFixed(3)}`);
