'use strict';

// Sort the 88 into tiers by what the depth pass says (05-jump.js fixed), and
// record whether OCCLUDING truth (silhouette or boundary) runs along each one
// -- visible or hidden -- and along its rotated copy.
//
//   h < 2 cm              C no step
//   2 cm <= h < 5 cm      B marginal
//   h >= 5 cm, break within 2 px of the line   A1 step under
//   h >= 5 cm, break pinned at 2-2.5 px        A2 step beside
//
//   out/classified.json

const { REPO, VIEWS, loadView, rotated, mid, read, write } = require('./load');
const { lineAngleDifference, MIN_VISIBLE, pointToSegment } = require(`${REPO}/src/lab/match`);

const the88 = read('the88.json');
const jump = new Map(read('jump-fixed.json').map((r) => [`${r.view}/${r.id}`, r]));

// Fraction of 9 samples with an occluding truth edge within 3 px at <= 30 degrees.
function occluderAlong(s, edges) {
  const n = 9;
  let vis = 0, hid = 0;
  for (let k = 0; k < n; k++) {
    const u = k / (n - 1), px = s.x0 + (s.x1 - s.x0) * u, py = s.y0 + (s.y1 - s.y0) * u;
    let v = false, h = false;
    for (const e of edges) {
      if (lineAngleDifference(s.angle, e.angle) > 30 || e.length < 1) continue;
      if (pointToSegment(px, py, e.x0, e.y0, e.x1, e.y1) > 3) continue;
      if (e.visible >= MIN_VISIBLE) v = true; else h = true;
    }
    if (v) vis++; else if (h) hid++;
  }
  return { vis: vis / n, hid: hid / n };
}

const rows = [];
for (const name of VIEWS) {
  const v = loadView(name);
  const occ = v.slots.get('T').filter((f) => f.type === 'gt-edge' && (f.cause === 'silhouette' || f.cause === 'boundary'));
  for (const r of the88.filter((q) => q.view === name)) {
    const p = jump.get(`${name}/${r.id}`);
    const o = occluderAlong(r, occ), c = occluderAlong(rotated(r), occ);
    const us = p.crossings.map((x) => x.u), gaps = p.crossings.map((x) => x.gap);
    const strong = us.filter((u, i) => gaps[i] >= 0.02).map(Math.abs);
    const uMed = strong.length ? mid(strong) : null;
    const tier = p.stepMedian < 0.02 ? 'C no step'
      : p.stepMedian < 0.05 ? 'B marginal'
      : uMed >= 2 ? 'A2 step beside' : 'A1 step under';
    const occLabel = o.vis >= 0.67 ? 'visible occluder along' : o.hid >= 0.67 ? 'hidden occluder along'
      : o.vis + o.hid >= 0.67 ? 'mixed occluder along' : 'no occluder along';
    rows.push({ ...r, jump: p.stepMedian, stepCrossings: p.stepCrossings, us, gaps, uMed, tier,
      occVis: o.vis, occHid: o.hid, ctrlVis: c.vis, ctrlHid: c.hid, occ: occLabel, ctrlOcc: c.vis + c.hid >= 0.67 });
  }
}
write('classified.json', rows);

const f = (x, d = 2) => (x == null ? '  -  ' : x.toFixed(d));
console.log('view   id   len jump(m) n>=2cm | excess nStep slant | occluder vis/hid  rotated vis/hid | mDist mAng | tier            | break u* per crossing');
for (const r of [...rows].sort((a, b) => b.jump - a.jump)) {
  console.log(r.view, String(r.id).padStart(3), f(r.length, 1).padStart(5), f(r.jump, 3).padStart(7), String(r.stepCrossings).padStart(6), ' |',
    f(r.depthExcess, 3), f(r.normalStep, 0).padStart(5), f(r.slant, 0).padStart(5), ' |', f(r.occVis), f(r.occHid), '       ', f(r.ctrlVis), f(r.ctrlHid), ' |',
    f(r.matchDistance, 1).padStart(5), f(r.matchAngle, 0).padStart(4), ' |', r.tier.padEnd(15), '|', r.us.map((u) => u.toFixed(1)).join(' '));
}

console.log('');
const tiers = {};
for (const r of rows) (tiers[r.tier] ??= []).push(r);
for (const [t, g] of Object.entries(tiers).sort()) {
  const occ = {};
  for (const r of g) occ[r.occ] = (occ[r.occ] ?? 0) + 1;
  const med = (k) => mid(g.map((r) => r[k]));
  console.log(t.padEnd(15), String(g.length).padStart(3), JSON.stringify(occ), '| rotated copy also along an occluder:', g.filter((r) => r.ctrlOcc).length,
    `| median normalStep ${med('normalStep').toFixed(0)} slant ${med('slant').toFixed(0)} excess ${med('depthExcess').toFixed(3)} matchDist ${med('matchDistance').toFixed(1)}`);
}

// The same detection under both light levels is the same geometry: count it once.
let pairs = 0;
console.log('\nthe same place under both light levels:');
for (const a of rows.filter((r) => r.view.endsWith('l0'))) {
  const b = rows.find((q) => q.view === a.view.replace('l0', 'l1') &&
    Math.hypot((q.x0 + q.x1) / 2 - (a.x0 + a.x1) / 2, (q.y0 + q.y1) / 2 - (a.y0 + a.y1) / 2) < 2.5);
  if (!b) continue;
  pairs++;
  console.log(`  ${a.view} #${a.id} ${a.tier}  <->  ${b.view} #${b.id} ${b.tier}`);
}
console.log(`${pairs} pairs -> ${rows.length - pairs} distinct places`);
