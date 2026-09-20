'use strict';

/**
 * How much of 01's answer is the `minMag` threshold?
 *
 *   node 02-minmag.js [value ...]
 *
 * Short answer on the nut: segment count halves across the sweep and the chain
 * count barely moves, so the note's finding is not a threshold artefact.
 */

const path = require('node:path');
const {
  ROOT, DEFAULTS, decodePNG, tlsLine, circleFit, sweepAbout,
  labelMap, groupsOf, labelCount,
} = require('./lib.js');

const IMAGE = path.join(ROOT, 'assets', 'nut-1-10x-256x256.png');
const VALUES = process.argv.slice(2).map(Number).filter((v) => Number.isFinite(v) && v >= 0);
const SWEEP = VALUES.length > 0 ? VALUES : [0.002, 0.005, 0.01, 0.02];

const GAIN = 1.5, MIN_SWEEP = 8;
const CHAIN_GAP = 4.0, MIN_TURN = 2, MAX_TURN = 40, CHAIN_RESIDUAL = 1.0;

const img = decodePNG(IMAGE);
const W = img.width;

console.log(`${path.basename(IMAGE)}  ${img.width}x${img.height}`);
console.log(`  everything else at defaults: angleTol ${DEFAULTS.segments.angleTol},`
  + ` maxResidual ${DEFAULTS.segments.maxResidual}, minPixels ${DEFAULTS.segments.minPixels}`);
console.log('\n  minMag   segments   after merge   labels   arc-preferring   edge px   chains');

for (const minMag of SWEEP) {
  const map = labelMap(img, { minMag });

  const records = [];
  for (const [id, pts] of [...groupsOf(map.after, W)].sort((a, b) => a[0] - b[0])) {
    const line = tlsLine(pts);
    const circle = circleFit(pts);
    if (circle === null) continue;
    let lo = Infinity, hi = -Infinity, a = null, b = null;
    for (const p of pts) {
      const t = line.tx * p.x + line.ty * p.y;
      if (t < lo) { lo = t; a = p; }
      if (t > hi) { hi = t; b = p; }
    }
    records.push({ id, pts, n: pts.length, a, b, line, circle,
      ...sweepAbout(pts, circle.cx, circle.cy), gain: line.rms / Math.max(circle.rms, 1e-9) });
  }

  const arcLike = records.filter((r) => r.gain >= GAIN && r.sweep >= MIN_SWEEP);

  /* 01's chaining, minus the reporting. */
  const parent = new Map(records.map((r) => [r.id, r.id]));
  const find = (i) => {
    while (parent.get(i) !== i) { parent.set(i, parent.get(parent.get(i))); i = parent.get(i); }
    return i;
  };
  const members = new Map(records.map((r) => [r.id, [r]]));
  const angle = (r) => Math.atan2(r.line.ty, r.line.tx) * 180 / Math.PI;

  const candidates = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const p = records[i], q = records[j];
      let best = Infinity;
      for (const [e, f] of [[p.a, q.a], [p.a, q.b], [p.b, q.a], [p.b, q.b]]) {
        best = Math.min(best, Math.hypot(e.x - f.x, e.y - f.y));
      }
      if (best > CHAIN_GAP) continue;
      let turn = Math.abs(angle(p) - angle(q)) % 180;
      if (turn > 90) turn = 180 - turn;
      if (turn < MIN_TURN || turn > MAX_TURN) continue;
      candidates.push({ gap: best, p, q });
    }
  }
  candidates.sort((a, b) => a.gap - b.gap || a.p.id - b.p.id || a.q.id - b.q.id);

  for (const { p, q } of candidates) {
    const ra = find(p.id), rb = find(q.id);
    if (ra === rb) continue;
    const pts = [...members.get(ra), ...members.get(rb)].flatMap((r) => r.pts);
    const c = circleFit(pts);
    if (c === null || c.max > CHAIN_RESIDUAL) continue;
    parent.set(ra, rb);
    members.set(rb, [...members.get(ra), ...members.get(rb)]);
    members.delete(ra);
  }
  const roots = new Map();
  for (const r of records) {
    const root = find(r.id);
    roots.set(root, (roots.get(root) ?? 0) + 1);
  }
  const chains = [...roots.values()].filter((n) => n > 1).length;

  console.log(`  ${String(minMag).padStart(6)}   ${String(labelCount(map.before)).padStart(8)}`
    + `   ${String(labelCount(map.after)).padStart(11)}   ${String(records.length).padStart(6)}`
    + `   ${String(arcLike.length).padStart(14)}`
    + `   ${String(records.reduce((s, r) => s + r.n, 0)).padStart(7)}`
    + `   ${String(chains).padStart(6)}`);
}
