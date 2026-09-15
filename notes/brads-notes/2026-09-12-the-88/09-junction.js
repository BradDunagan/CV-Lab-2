'use strict';

// The automated junction proxies, and why none of them counts it.
//
// Near each segment: in how many distinct directions do the VISIBLE OCCLUDING
// truth edges run (a contour turning, or two contours meeting)? Is there a
// truth corner vertex (angle >= 30, visible) within 3 px? Is the segment a
// member of a detected corner, and did that corner match? All three have base
// rates of 60-100% on the matched segments, which is why the junction class
// in the note is by eye, from the crops.

const { REPO, VIEWS, loadView, verdicts, group, read } = require('./load');
const { pointToSegment, lineAngleDifference, MIN_VISIBLE } = require(`${REPO}/src/lab/match`);

const tiers = new Map(read('classified.json').map((r) => [`${r.view}/${r.id}`, r.tier]));
const R = 3;

function near(f, e) {
  for (let k = 0; k <= 8; k++) {
    const u = k / 8;
    if (pointToSegment(f.x0 + (f.x1 - f.x0) * u, f.y0 + (f.y1 - f.y0) * u, e.x0, e.y0, e.x1, e.y1) <= R) return true;
    if (pointToSegment(e.x0 + (e.x1 - e.x0) * u, e.y0 + (e.y1 - e.y0) * u, f.x0, f.y0, f.x1, f.y1) <= R) return true;
  }
  return false;
}

// Greedy length-weighted clustering of orientations 30 degrees apart; clusters holding >= 2 px.
function directions(edges) {
  const cl = [];
  for (const e of [...edges].sort((a, b) => b.length - a.length)) {
    const c = cl.find((q) => lineAngleDifference(q.angle, e.angle) <= 30);
    if (c) c.len += e.length; else cl.push({ angle: e.angle, len: e.length });
  }
  return cl.filter((c) => c.len >= 2);
}

const rows = [];
for (const name of VIEWS) {
  const v = loadView(name);
  const T = v.slots.get('T');
  const occ = T.filter((f) => f.type === 'gt-edge' && f.cause !== 'crease' && f.visible >= MIN_VISIBLE);
  const verts = T.filter((f) => f.type === 'gt-vertex' && f.visible && f.onFrame && f.angle >= 30);
  const { EF, MF } = verdicts(v);
  const C = v.slots.get('C');
  const MC = new Map(v.slots.get('MC').filter((r) => r.detected !== null).map((r) => [r.detected, r.role]));
  for (const f of v.slots.get('F')) {
    const dirs = directions(occ.filter((e) => near(f, e)));
    const corners = C.filter((c) => c.segments.includes(f.id));
    rows.push({ role: MF.get(f.id).role, cause: EF.get(f.id).cause, tier: tiers.get(`${name}/${f.id}`) ?? null,
      nDirs: dirs.length,
      along: dirs.filter((d) => lineAngleDifference(d.angle, f.angle) <= 30).length,
      offAxis: dirs.filter((d) => lineAngleDifference(d.angle, f.angle) > 30).length,
      vtx: verts.filter((q) => pointToSegment(q.x, q.y, f.x0, f.y0, f.x1, f.y1) <= R).length,
      inCorner: corners.length > 0,
      cornerHit: corners.some((k) => MC.get(k.id) === 'hit') });
  }
}

const groups = {};
for (const r of rows) (groups[group(r)] ??= []).push(r);
const n = (g, p) => String(g.filter(p).length);
console.log('group'.padEnd(26), 'n'.padStart(4), '| no occluder | along only | along+off-axis | off-axis only | truth corner vtx | in a detected corner (that matched)');
for (const [k, g] of Object.entries(groups).sort()) {
  console.log(k.padEnd(26), String(g.length).padStart(4), '|', n(g, (r) => r.nDirs === 0).padStart(11), '|', n(g, (r) => r.along && !r.offAxis).padStart(10), '|',
    n(g, (r) => r.along && r.offAxis).padStart(14), '|', n(g, (r) => !r.along && r.offAxis).padStart(13), '|', n(g, (r) => r.vtx > 0).padStart(16), '|',
    n(g, (r) => r.inCorner).padStart(6), `(${n(g, (r) => r.cornerHit)})`);
}
