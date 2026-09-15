'use strict';

// The first reading, which 03 then overturns. For each of the 88: foot points
// of the per-sample nearest VISIBLE truth edge, the direction they line up in,
// how far they span, and whether a hidden edge was nearer. It looked like the
// geometry runs along the detection and match was comparing against one short
// facet of a zigzag.
//
//   out/along.json

const { REPO, VIEWS, loadView, read, write } = require('./load');
const { lineAngleDifference, MIN_VISIBLE, sampleCount } = require(`${REPO}/src/lab/match`);

function foot(px, py, e) {
  const dx = e.x1 - e.x0, dy = e.y1 - e.y0, L = dx * dx + dy * dy;
  let t = L < 1e-12 ? 0 : ((px - e.x0) * dx + (py - e.y0) * dy) / L;
  t = Math.max(0, Math.min(1, t));
  const fx = e.x0 + t * dx, fy = e.y0 + t * dy;
  return { fx, fy, d: Math.hypot(px - fx, py - fy) };
}

const the88 = read('the88.json');
const rows = [];
for (const name of VIEWS) {
  const v = loadView(name);
  const T = v.slots.get('T');
  const vis = T.filter((f) => f.type === 'gt-edge' && f.visible >= MIN_VISIBLE);
  const all = T.filter((f) => f.type === 'gt-edge');
  for (const r of the88.filter((q) => q.view === name)) {
    const n = sampleCount(r.length);
    const feet = [], causes = {};
    let hiddenCloser = 0;
    for (let s = 0; s < n; s++) {
      const u = s / (n - 1), px = r.x0 + (r.x1 - r.x0) * u, py = r.y0 + (r.y1 - r.y0) * u;
      let best = null, bestAny = null;
      for (const e of vis) { const f = foot(px, py, e); if (!best || f.d < best.d) best = { ...f, e }; }
      for (const e of all) { const f = foot(px, py, e); if (!bestAny || f.d < bestAny.d) bestAny = { ...f, e }; }
      if (bestAny.d + 0.5 < best.d) hiddenCloser++;
      feet.push(best);
      causes[best.e.cause] = (causes[best.e.cause] ?? 0) + 1;
    }
    const mx = feet.reduce((a, f) => a + f.fx, 0) / n, my = feet.reduce((a, f) => a + f.fy, 0) / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const f of feet) { sxx += (f.fx - mx) ** 2; syy += (f.fy - my) ** 2; sxy += (f.fx - mx) * (f.fy - my); }
    let footAngle = (Math.atan2(2 * sxy, sxx - syy) / 2) * 180 / Math.PI;
    if (footAngle < 0) footAngle += 180;
    const c = Math.cos(footAngle * Math.PI / 180), si = Math.sin(footAngle * Math.PI / 180);
    const ext = feet.map((f) => (f.fx - mx) * c + (f.fy - my) * si);
    const distinct = [...new Set(feet.map((f) => f.e))];
    rows.push({ ...r,
      footAngleDiff: lineAngleDifference(r.angle, footAngle),
      footExtentRatio: (Math.max(...ext) - Math.min(...ext)) / r.length,
      within3: feet.filter((f) => f.d <= 3).length / n,
      distinctEdges: distinct.length,
      meanEdgeLength: distinct.reduce((a, e) => a + e.length, 0) / distinct.length,
      causes, hiddenCloserFrac: hiddenCloser / n });
  }
}
write('along.json', rows);

const f = (x, d = 1) => x.toFixed(d);
console.log('view   id   len mDist mAng | footAngDiff footExt within3 nEdges meanEdgeLen | excess slant nStep | nearest causes  hiddenCloser');
for (const r of rows.sort((p, q) => p.matchDistance - q.matchDistance)) {
  console.log(r.view, String(r.id).padStart(3), f(r.length).padStart(5), f(r.matchDistance).padStart(5), f(r.matchAngle, 0).padStart(4), '|',
    f(r.footAngleDiff, 0).padStart(6), f(r.footExtentRatio, 2).padStart(9), f(r.within3, 2).padStart(7), String(r.distinctEdges).padStart(6), f(r.meanEdgeLength).padStart(10), ' |',
    f(r.depthExcess, 3), f(r.slant, 0).padStart(4), f(r.normalStep, 0).padStart(5), ' |', JSON.stringify(r.causes), f(r.hiddenCloserFrac, 2));
}
