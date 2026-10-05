'use strict';
// Tracking down each view's approach with pairs.trackPair, per pair.
//   node track.js <run> [minPx=3]
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '../../../');
const { grayOf, slot } = require('./lib');
const { fitPairs, findPairs, trackPair } = require(R + 'src/lab/pairs');
const GS = require(R + 'src/lab/gapsweep');
const run = process.argv[2], minPx = Number(process.argv[3] ?? 3);
const meta = JSON.parse(fs.readFileSync(R + `results/${run}/pairs/gap-sweep.json`, 'utf8'));
const parts = { moving: meta.moving, target: meta.target };
const shots = JSON.parse(fs.readFileSync(R + `generated/${run}/shots.json`, 'utf8'));
const views = new Map();
for (const s of shots) { const k = s.view ? `${s.view.yaw}/${s.view.elevation}` : '-'; if (!views.has(k)) views.set(k, []); views.get(k).push(s); }
const keyOf = (angle) => Math.round(angle / 15) % 12;
// Gap along the carried line's normal at the point of it nearest p, to the moving line.
function gapAt(line, moving, toward, p) {
  const L = GS.line(line), M = GS.line(moving);
  const q = [L.p0[0] + L.u[0] * ((p[0] - L.p0[0]) * L.u[0] + (p[1] - L.p0[1]) * L.u[1]), L.p0[1] + L.u[1] * ((p[0] - L.p0[0]) * L.u[0] + (p[1] - L.p0[1]) * L.u[1])];
  let n = L.n; if ((toward[0] - q[0]) * n[0] + (toward[1] - q[1]) * n[1] < 0) n = [-n[0], -n[1]];
  const det = M.u[0] * -n[1] - M.u[1] * -n[0];
  const r = [q[0] - M.p0[0], q[1] - M.p0[1]];
  return (M.u[0] * r[1] - M.u[1] * r[0]) / det;
}
const out = [];
for (const [view, list] of views) {
  list.sort((a, b) => b.gapMm - a.gapMm);
  const carried = new Map();
  for (const s of list) {
    const base = s.name.replace(/\.png$/, '');
    const F = JSON.parse(fs.readFileSync(R + `results/${run}/pairs/${base}.features.json`, 'utf8'));
    const G = grayOf(R + `generated/${run}/${s.name}`);
    const segs = slot(F, 'F'), truth = slot(F, 'T');
    const P = fitPairs(segs, G), H = findPairs(segs, G);
    const rows = GS.gapRows({ truth, segments: segs, explained: slot(F, 'EF'), matches: slot(F, 'MF'), pairs: [...P, ...H] }, s, parts)
      .filter((r) => r.pair !== null);
    const tps = GS.truthPairs(truth, parts.moving, parts.target, Math.abs(s.separationMm ?? s.gapMm) / 1000, GS.DEFAULTS);
    const keys = new Set([...rows.map((r) => keyOf(r.pairAngle)), ...carried.keys()]);
    for (const key of keys) {
      const row = rows.find((r) => keyOf(r.pairAngle) === key);
      const c = carried.get(key);
      let tracked = null;
      if (c) {
        const r = trackPair(G, c, { guess: c.last });
        const mid = [(c.line.x0 + c.line.x1) / 2, (c.line.y0 + c.line.y1) / 2];
        const T = tps.map((p) => p.facing).sort((p, q) => Math.hypot(p.at[0] - mid[0], p.at[1] - mid[1]) - Math.hypot(q.at[0] - mid[0], q.at[1] - mid[1]))[0];
        if (r) {
          const gap = T ? gapAt(c.line, r.moving, c.toward, T.at) : r.gap;
          tracked = { gap, err: T ? gap - T.gap : null, truePx: T?.gap ?? 0, sigma: r.gapSigma, rms: r.rms };
          c.last = Math.max(gap, 0.25);
        }
      }
      out.push({ view, gapMm: s.gapMm, key, truePx: row?.trueGapPx ?? tracked?.truePx ?? null,
        fit: row?.refit ? { err: row.refit.errorPx, from: row.refit.from } : null, tracked });
      if (!c && row?.refit?.from === 'pair' && row.refit.gapPx >= minPx) {
        const rec = P.find((p) => p.id === row.refit.pair);
        const [mv, tg] = rec.a.segment === row.detectedPair[1] ? [rec.b, rec.a] : [rec.a, rec.b];
        carried.set(key, { line: tg, toward: [(mv.x0 + mv.x1) / 2, (mv.y0 + mv.y1) / 2],
          stripLevel: rec.levels[1], aperture: rec.aperture, last: row.refit.gapPx, fromMm: s.gapMm });
      }
    }
  }
}
fs.writeFileSync(R + `results/${run}/track.json`, JSON.stringify(out, null, 1));
const f = (v) => (v == null ? '     -' : v.toFixed(2).padStart(6));
for (const g of [...new Set(out.map((r) => r.gapMm))].sort((a, b) => b - a)) {
  console.log(`== ${g} mm   view    pair  truePx  fitted         tracked  sigma   rms`);
  for (const r of out.filter((r) => r.gapMm === g)) console.log(`   ${r.view.padEnd(7)} ${String(r.key).padStart(4)}  ${f(r.truePx)}  ${f(r.fit?.err)} ${(r.fit?.from ?? '').padEnd(7)}  ${f(r.tracked?.err)}  ${f(r.tracked?.sigma)}  ${r.tracked ? r.tracked.rms.toExponential(1) : ''}  ${r.tracked ? 'gap ' + r.tracked.gap.toFixed(2) : ''}`);
}
