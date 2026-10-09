// Predicted edges (predictEdges, from geometry.json) against pt-lab's own
// extraction at the same believed poses (npm run believed-truth), shot by shot.
//   node compare.mjs <pt-lab dir> <predicted dir> [minVisible]
import fs from 'node:fs';
import path from 'node:path';
const [ptDir, prDir, minArg] = process.argv.slice(2);
const minVisible = Number(minArg ?? 0.5);
const shots = JSON.parse(fs.readFileSync(path.join(ptDir, 'shots.json'), 'utf8'));
let n = 0, unmatched = 0, extra = 0, worstPx = 0, worstVertexPx = 0, flips = [], dv = [];
const ends = (e) => [[e.x0, e.y0], [e.x1, e.y1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const endGap = (a, b) => { const [p, q] = ends(a), [r, s] = ends(b); return Math.min(Math.max(dist(p, r), dist(q, s)), Math.max(dist(p, s), dist(q, r))); };
for (const s of shots) {
  const f = s.name.replace(/\.png$/, '.gt.json');
  const pt = JSON.parse(fs.readFileSync(path.join(ptDir, f), 'utf8'));
  const pr = JSON.parse(fs.readFileSync(path.join(prDir, f), 'utf8'));
  const used = new Set();
  for (const e of pt.edges) {
    n++;
    let best = null, gap = Infinity;
    for (const c of pr.edges) {
      if (used.has(c) || c.cause !== e.cause || c.objects.join() !== e.objects.join()) continue;
      const g = endGap(e, c);
      if (g < gap) { gap = g; best = c; }
    }
    if (!best || gap > 1) { unmatched++; console.log(`  unmatched ${f} ${e.cause} ${e.objects} vis ${e.visible.toFixed(2)} (nearest ${gap.toFixed(3)} px)`); continue; }
    used.add(best);
    worstPx = Math.max(worstPx, gap);
    dv.push({ d: best.visible - e.visible, f, e, best });
    if ((e.visible >= minVisible) !== (best.visible >= minVisible)) flips.push({ f, e, best });
  }
  extra += pr.edges.length - used.size;
  for (const v of pt.vertices) {
    const w = pr.vertices.reduce((b, c) => (dist([c.x, c.y], [v.x, v.y]) < dist([b.x, b.y], [v.x, v.y]) ? c : b));
    worstVertexPx = Math.max(worstVertexPx, dist([w.x, w.y], [v.x, v.y]));
  }
}
const abs = dv.map((x) => Math.abs(x.d)).sort((a, b) => a - b);
const q = (p) => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))];
console.log(`${ptDir}: ${n} pt-lab edges, ${unmatched} unmatched, ${extra} predicted only; ` +
  `endpoints within ${worstPx.toExponential(2)} px, vertices within ${worstVertexPx.toExponential(2)} px`);
console.log(`  |visible difference|: median ${q(0.5).toFixed(3)}, 90% ${q(0.9).toFixed(3)}, max ${abs[abs.length - 1].toFixed(3)}; ` +
  `${dv.filter((x) => x.d !== 0).length} differ; ${flips.length} change side of ${minVisible}`);
for (const { f, e, best } of flips) console.log(`  flip ${f} ${e.cause} ${e.objects} pt-lab ${e.visible.toFixed(3)} predicted ${best.visible.toFixed(3)} len ${e.length.toFixed(1)}`);
