// Two-edge against three-edge (a soft shadow edge inside the strip) fits of one pair.
//   node proto.js <run> <shot base> <pair> ...
const fs = require('fs');
const R = require('path').join(__dirname, '../../../');
const { grayOf, slot } = require('../2026-10-04-carry/lib');
const { fitPairs, candidates, bandSamples, fitBand, DEFAULTS } = require(R + 'src/lab/pairs');
const GS = require(R + 'src/lab/gapsweep');
function proto(run, base, pairNo) {
  const F = JSON.parse(fs.readFileSync(R + `results/${run}/pairs/${base}.features.json`, 'utf8'));
  const G = grayOf(R + `generated/${run}/${base}.png`);
  const j = JSON.parse(fs.readFileSync(R + `results/${run}/pairs/gap-sweep.json`, 'utf8'));
  const segs = slot(F, 'F');
  const P = fitPairs(segs, G);
  const row = j.rows.find((r) => base.includes(`y${r.yaw}-e${r.elevation}-`) && (r.pose ? base.endsWith(`pose-${r.pose}`) : base.endsWith(`gap-${String(r.gapMm).replace('-', 'm').replace('.', 'p')}mm`)) && r.pair == pairNo);
  const rec = P.find((p) => p.id === row.refit.pair);
  const opts = { ...DEFAULTS };
  const { frames } = candidates(segs, opts);
  const frame = frames.find((f) => f.edges.map((e) => e.id).sort().join() === [rec.a.segment, rec.b.segment].sort().join());
  const samples = bandSamples(G, frame, opts);
  const fitOf = (edges) => fitBand(samples, { ...frame, edges }, { aperture: rec.aperture, slopedLevels: true });
  const two = fitOf(frame.edges);
  // Three: a soft edge started at a third and two thirds of the way across.
  const [e0, e1] = two.edges;
  let three = null;
  for (const [anchor, side] of [[0, 1], [2, -1]]) for (const width of [0.3, 1, 2]) {
    const mid = { c: 0, m: 0, soft: true, anchor, side, width };
    const fit = fitOf([{ c: e0.c, m: e0.m }, mid, { c: e1.c, m: e1.m }]);
    if (fit && (!three || fit.rms < three.rms)) three = fit;
  }
  // Read both against the truth, through the analysis's own reading.
  const at = (fit) => {
    const edge = (e) => { const p = (t) => { const hh = e.c + e.m * t; return [frame.ox + frame.ux * t + frame.nx * hh, frame.oy + frame.uy * t + frame.ny * hh]; };
      const [x0, y0] = p(-frame.half), [x1, y1] = p(frame.half); return { x0, y0, x1, y1 }; };
    const E = fit.edges;
    const r = { ...rec, a: { ...rec.a, ...edge(E[0]) }, b: { ...rec.b, ...edge(E[E.length - 1]) } };
    const rr = GS.gapRows({ truth: slot(F, 'T'), segments: segs, explained: slot(F, 'EF'), matches: slot(F, 'MF'), pairs: [r] }, { gapMm: row.gapMm, separationMm: row.poseMm ? Math.hypot(...row.poseMm) : Math.hypot(...[row.gapMm, 4, 0]) }, { moving: j.moving, target: j.target })
      .find((x) => x.refit && x.refit.pair === rec.id && Math.abs(x.trueGapPx - row.trueGapPx) < 0.05);
    return rr?.refit;
  };
  const a2 = at(two), a3 = three && at(three);
  const s = three?.edges[1];
  console.log(`${base} p${pairNo} gap ${row.trueGapPx.toFixed(2)}  two: rms ${two.rms.toFixed(4)} err ${a2?.errorPx?.toFixed(3)} tgt ${a2?.targetOffsetPx?.toFixed(3)}`
    + `   three: rms ${three?.rms.toFixed(4)} gain ${three ? (two.rms / three.rms).toFixed(2) : '-'} err ${a3?.errorPx?.toFixed(3)} tgt ${a3?.targetOffsetPx?.toFixed(3)}`
    + (s ? `  shadow at ${((s.c - three.edges[0].c) / (three.edges[2].c - three.edges[0].c)).toFixed(2)} of the strip, width ${s.width.toFixed(2)}, levels ${three.levels.map((v) => v.toFixed(3)).join('/')}` : ''));
}
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 3) proto(args[i], args[i + 1], args[i + 2]);
