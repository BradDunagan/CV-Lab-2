'use strict';

// Ask the depth pass, not the truth: is there a C0 break under each segment?
//
//   node 05-jump.js fixed   the instrument the note uses        out/jump-fixed.json
//   node 05-jump.js gap     dead end 2a, kept for the record    out/jump-gap.json
//   node 05-jump.js wide    dead end 2b, kept for the record    out/jump-wide.json
//
// At each of explain's seven crossings, depth is sampled every 0.25 px across
// the line and a break is searched for within explain's reach.
//
// fixed: fit z(u) = a + b(u-u0) + c*max(0,u-u0) + h*[u>u0] over u in
//   [-4.5, 4.5], leaving out |u-u0| < 0.75 where bilinear sampling ramps a
//   step. A fold fits with h ~ 0 (the two lines meet), a step with h = the
//   step. The lowest-residual u0 within +-2.5 px is kept. Every u0 is fitted
//   over the same window, which is what makes their residuals comparable.
//
// gap: the largest gap between a line fitted on [u-3, u-1] and one on
//   [u+1, u+3], over u within +-2.5 px. Reads a fold as a step: away from the
//   fold one window straddles the kink. Matched creases read 2.4 cm.
//
// wide: `fixed` with the search widened to +-4 px and the window moving with
//   u0 (3.5 px either side). The lowest residual is then a u0 whose windows
//   miss the step entirely; matched occlusions fall to a 9 mm median.

const { REPO, VIEWS, loadView, verdicts, group, quantile, write } = require('./load');
const { sample, median } = require(`${REPO}/src/lab/explain`);

const VARIANTS = {
  gap: { range: 5, reach: 2.5 },
  fixed: { range: 4.5, reach: 2.5, window: Infinity },
  wide: { range: 7, reach: 4, window: 3.5 },
};
const variant = process.argv[2] || 'fixed';
const V = VARIANTS[variant];
if (!V) { console.error(`variant must be one of ${Object.keys(VARIANTS).join(', ')}`); process.exit(2); }

const U = [];
for (let u = -V.range; u <= V.range + 1e-9; u += 0.25) U.push(+u.toFixed(2));

function lineFit(us, zs) {
  const n = us.length, mu = us.reduce((a, b) => a + b, 0) / n, mz = zs.reduce((a, b) => a + b, 0) / n;
  let suu = 0, suz = 0;
  for (let i = 0; i < n; i++) { suu += (us[i] - mu) ** 2; suz += (us[i] - mu) * (zs[i] - mz); }
  const b = suu > 0 ? suz / suu : 0;
  return (u) => mz + b * (u - mu);
}

function gapAt(depth, px, py, nx, ny, u) {
  const L = [], Lz = [], R = [], Rz = [];
  for (let w = 1; w <= 3 + 1e-9; w += 0.25) {
    L.push(u - w); Lz.push(sample(depth, px + nx * (u - w), py + ny * (u - w), 0));
    R.push(u + w); Rz.push(sample(depth, px + nx * (u + w), py + ny * (u + w), 0));
  }
  return Math.abs(lineFit(L, Lz)(u) - lineFit(R, Rz)(u));
}

function solve4(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 4; c++) {
    let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 4; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let j = c; j < 5; j++) M[r][j] -= k * M[c][j]; }
  }
  return M.map((row, i) => row[4] / row[i]);
}

function jumpAt(depth, px, py, nx, ny) {
  if (variant === 'gap') {
    let best = { gap: -1, u: 0 };
    for (const u of U) {
      if (Math.abs(u) > V.reach) continue;
      const g = gapAt(depth, px, py, nx, ny, u);
      if (g > best.gap) best = { gap: g, u };
    }
    return best;
  }
  const prof = U.map((u) => [u, sample(depth, px + nx * u, py + ny * u, 0)]);
  let best = null;
  for (const u0 of U) {
    if (Math.abs(u0) > V.reach) continue;
    const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], bb = [0, 0, 0, 0];
    const rows = [];
    for (const [u, z] of prof) {
      if (Math.abs(u - u0) < 0.75 || Math.abs(u - u0) > V.window) continue;
      const x = [1, u - u0, Math.max(0, u - u0), u > u0 ? 1 : 0];
      rows.push([x, z]);
      for (let i = 0; i < 4; i++) { bb[i] += x[i] * z; for (let j = 0; j < 4; j++) A[i][j] += x[i] * x[j]; }
    }
    const p = solve4(A, bb);
    if (!p) continue;
    let rss = 0;
    for (const [x, z] of rows) { const e = z - (p[0] + p[1] * x[1] + p[2] * x[2] + p[3] * x[3]); rss += e * e; }
    if (!best || rss < best.rss) best = { rss, u: u0, gap: Math.abs(p[3]) };
  }
  return best;
}

function profileSegment(f, depth) {
  const dx = f.x1 - f.x0, dy = f.y1 - f.y0, len = Math.hypot(dx, dy);
  const nx = -dy / len, ny = dx / len;
  const crossings = [];
  for (let i = 0; i < 7; i++) {
    const t = (i + 1) / 8;
    crossings.push({ along: t * len, ...jumpAt(depth, f.x0 + dx * t, f.y0 + dy * t, nx, ny) });
  }
  // Where the break sits across the line, crossing by crossing, for the ones with a real break.
  const strong = crossings.filter((c) => c.gap >= 0.02);
  return {
    stepMedian: median(crossings.map((c) => c.gap)),
    stepCrossings: strong.length,
    crossings: crossings.map((c) => ({ along: c.along, u: c.u, gap: c.gap })),
  };
}

const rows = [];
for (const name of VIEWS) {
  const v = loadView(name);
  const { EF, MF } = verdicts(v);
  for (const f of v.slots.get('F')) {
    rows.push({ view: name, id: f.id, role: MF.get(f.id).role, cause: EF.get(f.id).cause,
      ...profileSegment(f, v.rasters.depth) });
  }
}
write(`jump-${variant}.json`, rows);

const groups = {};
for (const r of rows) (groups[group(r)] ??= []).push(r);
console.log(`variant ${variant}`);
console.log('group'.padEnd(22), 'n'.padStart(4), '  jump h (m): p10    p25    p50    p75    p90   | >=2cm on >=4 of 7');
for (const [k, g] of Object.entries(groups).sort()) {
  const s = g.map((r) => r.stepMedian);
  console.log(k.padEnd(22), String(g.length).padStart(4), '         ', [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => quantile(s, p).toFixed(3)).join('  '),
    '  |', g.filter((r) => r.stepCrossings >= 4).length);
}
