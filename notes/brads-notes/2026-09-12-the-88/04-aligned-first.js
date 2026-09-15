'use strict';

// Dead end 1b: a looser matcher is not evidence either.
//
// match as it is, against match asking for the nearest ALIGNED geometry --
// candidates filtered to within 20 degrees first, then the same median
// per-sample distance <= 3 px. Both on the real segments and on rotated
// copies. It rescues 45 of the 88, and takes rotated-copy hits from 37 to 127.

const { REPO, VIEWS, loadView, rotated, verdicts } = require('./load');
const { matchFeatures, nearestAlong, sampleCount, lineAngleDifference, MIN_VISIBLE } = require(`${REPO}/src/lab/match`);

const rows = [];
for (const name of VIEWS) {
  const v = loadView(name);
  const T = v.slots.get('T');
  const vis = T.filter((f) => f.type === 'gt-edge' && f.visible >= MIN_VISIBLE);
  const { EF } = verdicts(v);
  const F = v.slots.get('F');
  const rotF = F.map(rotated);
  const asRun = (list) => new Map(matchFeatures(list, T).filter((r) => r.detected !== null).map((r) => [r.detected, r.role]));
  const orig = asRun(F), origRot = asRun(rotF);
  const aligned = (seg) => {
    const c = vis.filter((e) => lineAngleDifference(seg.angle, e.angle) <= 20);
    return nearestAlong(seg, c, sampleCount(seg.length)).distance <= 3 ? 'hit' : 'false-positive';
  };
  F.forEach((f, i) => rows.push({ cause: EF.get(f.id).cause,
    orig: orig.get(f.id), aligned: aligned(f), origRot: origRot.get(f.id), alignedRot: aligned(rotF[i]) }));
}

const hits = (xs, k) => xs.filter((r) => r[k] === 'hit').length;
console.log(`all ${rows.length}: hits as run ${hits(rows, 'orig')}, aligned-first ${hits(rows, 'aligned')}` +
  ` | rotated copies: as run ${hits(rows, 'origRot')}, aligned-first ${hits(rows, 'alignedRot')}`);
const inv = rows.filter((r) => r.orig !== 'hit');
console.log(`invented ${inv.length} that become hits under aligned-first: ${hits(inv, 'aligned')}`);
for (const c of ['occlusion', 'shading', 'texture', 'crease']) {
  const g = inv.filter((r) => r.cause === c);
  console.log('  ', c.padEnd(10), String(g.length).padStart(4), '->', String(hits(g, 'aligned')).padStart(3), '   rotated copies of the same:', hits(g, 'alignedRot'));
}
console.log(`hits lost under aligned-first: ${rows.filter((r) => r.orig === 'hit' && r.aligned !== 'hit').length}`);
