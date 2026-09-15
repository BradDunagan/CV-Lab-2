'use strict';

// Dead end 1: the truth set cannot arbitrate here.
//
// The "runs along visible truth" measure from 02, over every detected segment
// in every view, AND over a copy of each rotated 90 degrees about its midpoint.
// On matched occlusions the measure discriminates (410 vs 120); on the 88 it
// does not (32 vs 21), because they sit in patches so dense with mesh edges
// that a perpendicular segment is as close to geometry as the real one.
//
//   out/allsegs.json

const { REPO, VIEWS, loadView, rotated, verdicts, group, mid, write } = require('./load');
const { lineAngleDifference, MIN_VISIBLE, sampleCount } = require(`${REPO}/src/lab/match`);

function foot(px, py, e) {
  const dx = e.x1 - e.x0, dy = e.y1 - e.y0, L = dx * dx + dy * dy;
  let t = L < 1e-12 ? 0 : ((px - e.x0) * dx + (py - e.y0) * dy) / L;
  t = Math.max(0, Math.min(1, t));
  const fx = e.x0 + t * dx, fy = e.y0 + t * dy;
  return { fx, fy, d: Math.hypot(px - fx, py - fy) };
}

function under(seg, vis) {
  const n = sampleCount(seg.length);
  const feet = [];
  for (let s = 0; s < n; s++) {
    const u = s / (n - 1), px = seg.x0 + (seg.x1 - seg.x0) * u, py = seg.y0 + (seg.y1 - seg.y0) * u;
    let best = null;
    for (const e of vis) { const f = foot(px, py, e); if (!best || f.d < best.d) best = f; }
    feet.push(best);
  }
  const mx = feet.reduce((a, f) => a + f.fx, 0) / n, my = feet.reduce((a, f) => a + f.fy, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const f of feet) { sxx += (f.fx - mx) ** 2; syy += (f.fy - my) ** 2; sxy += (f.fx - mx) * (f.fy - my); }
  let footAngle = (Math.atan2(2 * sxy, sxx - syy) / 2) * 180 / Math.PI;
  if (footAngle < 0) footAngle += 180;
  const c = Math.cos(footAngle * Math.PI / 180), s = Math.sin(footAngle * Math.PI / 180);
  const ext = feet.map((f) => (f.fx - mx) * c + (f.fy - my) * s);
  return {
    within15: feet.filter((f) => f.d <= 1.5).length / n,
    footAngleDiff: lineAngleDifference(seg.angle, footAngle),
    footExtent: (Math.max(...ext) - Math.min(...ext)) / seg.length,
  };
}

// >= 80% of samples within 1.5 px, foot direction within 20 deg, feet spanning >= 70% of the length.
const along = (u) => u.within15 >= 0.8 && u.footAngleDiff <= 20 && u.footExtent >= 0.7;

const rows = [];
for (const name of VIEWS) {
  const v = loadView(name);
  const vis = v.slots.get('T').filter((f) => f.type === 'gt-edge' && f.visible >= MIN_VISIBLE);
  const { EF, MF } = verdicts(v);
  for (const f of v.slots.get('F')) {
    const e = EF.get(f.id), m = MF.get(f.id);
    rows.push({ view: name, id: f.id, role: m.role, cause: e.cause, matchDistance: m.distance,
      ...under(f, vis), control: under(rotated(f), vis) });
  }
}
write('allsegs.json', rows);

// The 88 are the invented occlusions; no tiers exist yet at this step.
const groups = {};
for (const r of rows) (groups[group(r)] ??= []).push(r);
console.log('group'.padEnd(22), 'n'.padStart(4), '  along  rotated-along   within1.5 median (rotated)');
for (const [k, g] of Object.entries(groups).sort()) {
  console.log(k.padEnd(22), String(g.length).padStart(4), String(g.filter(along).length).padStart(6),
    String(g.filter((r) => along(r.control)).length).padStart(14), '       ',
    mid(g.map((r) => r.within15)).toFixed(2), `(${mid(g.map((r) => r.control.within15)).toFixed(2)})`);
}
