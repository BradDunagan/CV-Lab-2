'use strict';

// The confirmation: how explain's residual scales with its own offset.
//
// Across a step the residual does not depend on how far out you look
// (exponent 0). A plane extrapolated across a fold misses by slope x distance
// (1). A plane extrapolated over curvature misses by curvature x distance^2 (2).
// explain is rerun, unchanged, at offsets 1.25, 2.5 and 5.
//
// Also the cost of simply shrinking the offset: how many matched occlusions
// with a real >= 5 cm step fall below 2 cm at 1.25 px.
//
//   out/exponent.json

const { REPO, VIEWS, loadView, verdicts, group, mid, read, write } = require('./load');
const { explainFeature } = require(`${REPO}/src/lab/explain`);

const tiers = new Map(read('classified.json').map((r) => [`${r.view}/${r.id}`, r.tier]));
const jump = new Map(read('jump-fixed.json').map((r) => [`${r.view}/${r.id}`, r.stepMedian]));
const OFFSETS = [1.25, 2.5, 5];

const rows = [];
for (const name of VIEWS) {
  const v = loadView(name);
  const { EF, MF } = verdicts(v);
  for (const f of v.slots.get('F')) {
    const ex = {};
    for (const o of OFFSETS) ex[o] = explainFeature(f, v.rasters, { offset: o }).depthExcess;
    rows.push({ view: name, id: f.id, role: MF.get(f.id).role, cause: EF.get(f.id).cause,
      tier: tiers.get(`${name}/${f.id}`) ?? null, ex });
  }
}
write('exponent.json', rows);

const groups = {};
for (const r of rows) (groups[group(r)] ??= []).push(r);
const med = mid;
console.log('group'.padEnd(26), 'n'.padStart(4), '  excess@1.25   @2.5     @5  | exponent 1.25->2.5  2.5->5 | still >=2 cm @1.25');
for (const [k, g] of Object.entries(groups).sort()) {
  const e = (o) => med(g.map((r) => r.ex[o])).toFixed(3);
  const p1 = med(g.map((r) => Math.log2(r.ex[2.5] / r.ex[1.25])));
  const p2 = med(g.map((r) => Math.log2(r.ex[5] / r.ex[2.5])));
  console.log(k.padEnd(26), String(g.length).padStart(4), '     ', e(1.25), ' ', e(2.5), ' ', e(5), ' |      ',
    p1.toFixed(2), '     ', p2.toFixed(2), ' |', g.filter((r) => r.ex[1.25] >= 0.02).length);
}

const mo = rows.filter((r) => r.role === 'hit' && r.cause === 'occlusion');
const big = mo.filter((r) => jump.get(`${r.view}/${r.id}`) >= 0.05);
console.log(`\nshrinking the offset to 1.25: matched occlusions below 2 cm ${mo.filter((r) => r.ex[1.25] < 0.02).length} of ${mo.length};` +
  ` of those with a >= 5 cm step, ${big.filter((r) => r.ex[1.25] < 0.02).length} of ${big.length}`);
