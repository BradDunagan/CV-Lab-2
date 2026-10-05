// Brightness across a pair, binned by distance from the TRUE target edge,
// beside the fit's own model of it.  node profile.js <run> <yaw> <elev> <gapMm> <pair> [bin]
const fs = require('fs');
const R = require('path').join(__dirname, '../../../');
const { grayOf, slot } = require('../2026-10-04-carry/lib');
const { coverage } = require(R + 'src/lab/pairs');
const [run, yaw, elev, gap, pairNo, binArg] = process.argv.slice(2);
const bin = Number(binArg ?? 0.25);
const j = JSON.parse(fs.readFileSync(R + `results/${run}/pairs/gap-sweep.json`, 'utf8'));
const row = j.rows.find((r) => r.yaw == yaw && r.elevation == elev && r.gapMm == gap && r.pair == pairNo);
const name = `y${yaw}-e${elev}-gap-${String(gap).replace('-', 'm').replace('.', 'p')}mm`;
const F = JSON.parse(fs.readFileSync(R + `results/${run}/pairs/${name}.features.json`, 'utf8'));
const G = grayOf(R + `generated/${run}/${name}.png`);
const T = slot(F, 'T');
const [ta, tb] = row.truthPair.map((id) => T.find((t) => t.id === id)); // moving, target
const L = (s) => { const dx = s.x1 - s.x0, dy = s.y1 - s.y0, n = Math.hypot(dx, dy); return { x0: s.x0, y0: s.y0, ux: dx / n, uy: dy / n, len: n }; };
const tl = L(tb), ml = L(ta);
// Normal from the target toward the moving edge.
let nx = -tl.uy, ny = tl.ux;
const mid = [(ta.x0 + ta.x1) / 2, (ta.y0 + ta.y1) / 2];
if ((mid[0] - tl.x0) * nx + (mid[1] - tl.y0) * ny < 0) { nx = -nx; ny = -ny; }
const hOf = (x, y) => (x - tl.x0) * nx + (y - tl.y0) * ny;
const tOf = (x, y) => (x - tl.x0) * tl.ux + (y - tl.y0) * tl.uy;
// The stretch both truth edges cover, an eighth in from each end.
const tA = [tOf(ta.x0, ta.y0), tOf(ta.x1, ta.y1)].sort((a, b) => a - b);
const lo = Math.max(0, tA[0]), hi = Math.min(tl.len, tA[1]), inset = (hi - lo) / 8;
// The fit's record, as a model of every pixel.
const P = slot(F, 'P');
const rec = row.refit?.from === 'pair' ? P.find((p) => p.id === row.refit.pair) : null;
let model = null;
if (rec) {
  const ux = rec.ny, uy = -rec.nx; // the frame's along-direction
  const fr = (x, y) => [(x - rec.x) * ux + (y - rec.y) * uy, (x - rec.x) * rec.nx + (y - rec.y) * rec.ny];
  const edge = (e) => { const [t0, h0] = fr(e.x0, e.y0), [t1, h1] = fr(e.x1, e.y1); const m = (h1 - h0) / (t1 - t0); return { c: h0 - m * t0, m }; };
  const E = [edge(rec.a), edge(rec.b)];
  const a = (Math.min(Math.abs(rec.nx), Math.abs(rec.ny)) / 2) * rec.aperture, b = (Math.max(Math.abs(rec.nx), Math.abs(rec.ny)) / 2) * rec.aperture;
  const lv = (k, t) => rec.levels[k] + (rec.levelSlopes ? rec.levelSlopes[k] * t : 0);
  model = (x, y) => { const [t, h] = fr(x, y); let v = lv(0, t); for (let e = 0; e < 2; e++) v += (lv(e + 1, t) - lv(e, t)) * coverage(h - E[e].c - E[e].m * t, a, b); return v; };
}
const bins = new Map();
for (let y = 0; y < G.height; y++) for (let x = 0; x < G.width; x++) {
  const t = tOf(x, y), h = hOf(x, y);
  if (t < lo + inset || t > hi - inset || h < -5 || h > row.trueGapPx + 5) continue;
  const k = Math.floor(h / bin);
  if (!bins.has(k)) bins.set(k, { n: 0, v: 0, m: 0 });
  const b = bins.get(k); b.n++; b.v += G.data[y * G.width + x]; if (model) b.m += model(x, y);
}
const out = [...bins.entries()].sort((p, q) => p[0] - q[0]).map(([k, b]) => ({ h: (k + 0.5) * bin, v: b.v / b.n, m: model ? b.m / b.n : null, n: b.n }));
console.log(`${run} ${name} pair ${pairNo}: true gap ${row.trueGapPx.toFixed(2)} px, refit err ${row.refit?.errorPx?.toFixed(3)}, target offset ${row.refit?.targetOffsetPx?.toFixed(3)}, levels ${rec?.levels.map((v) => v.toFixed(3)).join('/')}`);
for (const p of out) {
  const bar = (v) => ' '.repeat(Math.max(0, Math.round(v * 120)));
  console.log(`${p.h.toFixed(2).padStart(6)}  ${p.v.toFixed(4)}  ${p.m === null ? '' : p.m.toFixed(4)}  ${p.m === null ? '' : (p.v - p.m >= 0 ? '+' : '') + (p.v - p.m).toFixed(4)}  n${p.n}`);
}
fs.writeFileSync(R + `results/${run}/pairs/profile-${name}-p${pairNo}.json`, JSON.stringify({ row: { gap: row.trueGapPx, err: row.refit?.errorPx, tgt: row.refit?.targetOffsetPx, mov: row.refit?.movingOffsetPx }, out }));
