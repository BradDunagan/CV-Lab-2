'use strict';
// Carry the strip level down an approach: from the last frame where the gap
// was wide enough to fit it, held in each narrower frame.  node carry.js <run> [minPx]
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '../../../');
const { grayOf, slot } = require('./lib');
const { fitPairs, findPairs } = require(R + 'src/lab/pairs');
const { gapRows } = require(R + 'src/lab/gapsweep');
const run = process.argv[2], minPx = Number(process.argv[3] ?? 2);
const meta = JSON.parse(fs.readFileSync(R + `results/${run}/pairs/gap-sweep.json`, 'utf8'));
const parts = { moving: meta.moving, target: meta.target };
const shots = JSON.parse(fs.readFileSync(R + `generated/${run}/shots.json`, 'utf8'));
const views = new Map();
for (const s of shots) { const k = s.view ? `${s.view.yaw}/${s.view.elevation}` : '-'; if (!views.has(k)) views.set(k, []); views.get(k).push(s); }
const out = [];
for (const [view, list] of views) {
  list.sort((a, b) => b.gapMm - a.gapMm);           // the approach: wide to contact
  const memory = new Map();                           // pair key -> {level, fromMm, fromPx}
  for (const s of list) {
    const base = s.name.replace(/\.png$/, '');
    const F = JSON.parse(fs.readFileSync(R + `results/${run}/pairs/${base}.features.json`, 'utf8'));
    const G = grayOf(R + `generated/${run}/${s.name}`);
    const segs = slot(F, 'F');
    const input = (pairs) => ({ truth: slot(F, 'T'), segments: segs, explained: slot(F, 'EF'), matches: slot(F, 'MF'), pairs });
    const fitted = gapRows(input([...fitPairs(segs, G), ...findPairs(segs, G)]), s, parts);
    for (const row of fitted) {
      if (row.pair === null) continue;
      const key = Math.round(row.pairAngle / 15);
      const held = memory.get(key);
      let carried = null;
      if (held) {
        const o = { strip: 'held', stripLevel: held.level };
        carried = gapRows(input([...fitPairs(segs, G, o), ...findPairs(segs, G, o)]), s, parts)
          .find((r) => r.pair !== null && Math.round(r.pairAngle / 15) === key) ?? null;
      }
      out.push({ view, gapMm: s.gapMm, key, truePx: row.trueGapPx,
        fit: row.refit ? { err: row.refit.errorPx, from: row.refit.from, level: row.refit.stripLevel, sigma: row.refit.gapSigma } : null,
        carry: carried?.refit ? { err: carried.refit.errorPx, from: carried.refit.from, sigma: carried.refit.gapSigma } : null,
        held: held ?? null });
      if (row.refit && row.refit.from === 'pair' && row.refit.gapPx >= minPx) memory.set(key, { level: row.refit.stripLevel, fromMm: s.gapMm, fromPx: row.refit.gapPx });
    }
  }
}
fs.writeFileSync(R + `results/${run}/carry.json`, JSON.stringify(out, null, 1));
const f = (v) => (v == null ? '     -' : v.toFixed(3).padStart(6));
const pxmm = new Map();
for (const g of [...new Set(out.map((r) => r.gapMm))].sort((a, b) => b - a)) {
  const rows = out.filter((r) => r.gapMm === g);
  const both = rows.filter((r) => r.fit && r.carry), onlyC = rows.filter((r) => !r.fit && r.carry), onlyF = rows.filter((r) => r.fit && !r.carry && r.held);
  const rms = (a) => (a.length ? Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length) : null);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  console.log(`${String(g).padStart(4)} mm  rows ${rows.length}  read fitted ${rows.filter((r) => r.fit).length}  carried ${rows.filter((r) => r.carry).length}  (carry only ${onlyC.length}, fitted only ${onlyF.length}, held available ${rows.filter((r) => r.held).length})`);
  if (both.length) console.log(`         where both read (${both.length}): fitted mean ${f(mean(both.map((r) => r.fit.err)))} rms ${f(rms(both.map((r) => r.fit.err)))} px   carried mean ${f(mean(both.map((r) => r.carry.err)))} rms ${f(rms(both.map((r) => r.carry.err)))} px`);
  if (onlyC.length) console.log(`         carried only: mean ${f(mean(onlyC.map((r) => r.carry.err)))} rms ${f(rms(onlyC.map((r) => r.carry.err)))} px`);
}
