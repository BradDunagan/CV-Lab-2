'use strict';

// match's own rule -- median per-sample nearest distance <= 3 px, modal edge
// within 20 degrees -- asked of the OCCLUDING truth only (silhouette and
// boundary), which is sparse enough for the rotated control to hold: matched
// occlusions hit 376 of 453 and their rotated copies 19. Against it the 88
// mostly still fail. Also: which kind of edge was the modal one as match ran.

const { REPO, VIEWS, loadView, rotated, verdicts, group, read } = require('./load');
const { nearestAlong, sampleCount, lineAngleDifference, MIN_VISIBLE } = require(`${REPO}/src/lab/match`);

const tiers = new Map(read('classified.json').map((r) => [`${r.view}/${r.id}`, r.tier]));

const rule = (seg, cands) => {
  const { distance, modal } = nearestAlong(seg, cands, sampleCount(seg.length));
  return { hit: modal !== null && distance <= 3 && lineAngleDifference(seg.angle, modal.angle) <= 20, modal };
};

const rows = [];
for (const name of VIEWS) {
  const v = loadView(name);
  const T = v.slots.get('T');
  const vis = T.filter((f) => f.type === 'gt-edge' && f.visible >= MIN_VISIBLE);
  const occ = vis.filter((f) => f.cause !== 'crease');
  const occAll = T.filter((f) => f.type === 'gt-edge' && f.cause !== 'crease');
  const { EF, MF } = verdicts(v);
  for (const f of v.slots.get('F')) {
    const rot = rotated(f);
    rows.push({ role: MF.get(f.id).role, cause: EF.get(f.id).cause, tier: tiers.get(`${name}/${f.id}`) ?? null,
      modalCause: rule(f, vis).modal?.cause,
      occHit: rule(f, occ).hit, occHitRot: rule(rot, occ).hit,
      occAllHit: rule(f, occAll).hit, occAllHitRot: rule(rot, occAll).hit });
  }
}

const groups = {};
for (const r of rows) (groups[group(r)] ??= []).push(r);
const n = (g, k) => g.filter((r) => r[k]).length;
console.log('group'.padEnd(26), 'n'.padStart(4), '| visible occluders: hit rotated | incl. hidden occluders: hit rotated | modal edge as match ran');
for (const [k, g] of Object.entries(groups).sort()) {
  const mc = {};
  for (const r of g) mc[r.modalCause] = (mc[r.modalCause] ?? 0) + 1;
  console.log(k.padEnd(26), String(g.length).padStart(4), '|                  ', String(n(g, 'occHit')).padStart(4), String(n(g, 'occHitRot')).padStart(7),
    ' |                        ', String(n(g, 'occAllHit')).padStart(4), String(n(g, 'occAllHitRot')).padStart(7), ' |', JSON.stringify(mc));
}
