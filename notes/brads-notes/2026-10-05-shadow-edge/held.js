// The base cube's edge held at where a clean frame of the same view read it;
// the moving edge fitted beside it, with and without an anchored shadow ramp.
//   node held.js <run> <yaw> <elev> <clean gapMm> <pair> <gapMm...>
const fs = require('fs');
const R = require('path').join(__dirname, '../../../');
const { grayOf, slot } = require('../2026-10-04-carry/lib');
const { fitPairs, candidates, bandSamples, fitBand, DEFAULTS } = require(R + 'src/lab/pairs');
const GS = require(R + 'src/lab/gapsweep');
const [run, yaw, elev, cleanMm, pairNo, ...gaps] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(R + `results/${run}/pairs/gap-sweep.json`, 'utf8'));
const nameOf = (g) => `y${yaw}-e${elev}-gap-${String(g).replace('-', 'm').replace('.', 'p')}mm`;
const rowOf = (g) => j.rows.find((r) => r.yaw == yaw && r.elevation == elev && r.gapMm == g && r.pair == pairNo);
const load = (g) => {
  const F = JSON.parse(fs.readFileSync(R + `results/${run}/pairs/${nameOf(g)}.features.json`, 'utf8'));
  const G = grayOf(R + `generated/${run}/${nameOf(g)}.png`);
  const P = fitPairs(slot(F, 'F'), G);
  const row = rowOf(g);
  if (!row?.refit || row.refit.from !== 'pair') return null;
  const rec = P.find((p) => p.id === row.refit.pair);
  return { F, G, P, row, rec };
};
// The still edge, from the clean frame: the record's edge on the target's segment.
const clean = load(cleanMm);
if (!clean) { console.log(`${nameOf(cleanMm)}: no clean pair to hold`); process.exit(0); }
const still = clean.rec.a.segment === clean.row.detectedPair[1] ? clean.rec.a : clean.rec.b;
for (const g of gaps) {
  const got = load(g);
  if (!got) { console.log(`${nameOf(g)} p${pairNo}: no refit pair`); continue; }
  const { F, G, row, rec } = got;
  const segs = slot(F, 'F');
  const { frames } = candidates(segs, DEFAULTS);
  const frame = frames.find((f) => f.edges.map((e) => e.id).sort().join() === [rec.a.segment, rec.b.segment].sort().join());
  // The still line in this frame's coordinates.
  const toFrame = (x, y) => [(x - frame.ox) * frame.ux + (y - frame.oy) * frame.uy, (x - frame.ox) * frame.nx + (y - frame.oy) * frame.ny];
  const [t0, h0] = toFrame(still.x0, still.y0), [t1, h1] = toFrame(still.x1, still.y1);
  const sm = (h1 - h0) / (t1 - t0), sc = h0 - sm * t0;
  const s = frame.edges.findIndex((e) => e.id === row.detectedPair[1]); // index of the still edge
  const mi = 1 - s;
  const samples = bandSamples(G, frame, DEFAULTS);
  const base = frame.edges.map((e, k) => (k === s ? { c: sc, m: sm } : { c: e.c, m: e.m }));
  const two = fitBand(samples, { ...frame, edges: base }, { aperture: rec.aperture, slopedLevels: true, heldEdges: [s] });
  let three = null;
  for (const width of [0.3, 1, 2]) {
    const soft = { c: 0, m: 0, soft: true, anchor: s === 0 ? 0 : 2, side: s === 0 ? 1 : -1, width };
    const edges = [base[0], soft, base[1]];
    const fit = fitBand(samples, { ...frame, edges }, { aperture: rec.aperture, slopedLevels: true, heldEdges: [s === 0 ? 0 : 2] });
    if (fit && (!three || fit.rms < three.rms)) three = fit;
  }
  // The gap at the truth's measuring point, as the analysis reads it.
  const read = (fit) => {
    if (!fit) return null;
    const E = fit.edges;
    const line = (e) => { const p = (t) => { const hh = e.c + e.m * t; return [frame.ox + frame.ux * t + frame.nx * hh, frame.oy + frame.uy * t + frame.ny * hh]; };
      const [x0, y0] = p(-frame.half), [x1, y1] = p(frame.half); return { x0, y0, x1, y1 }; };
    const first = E[0], last = E[E.length - 1];
    const r = { ...rec, a: { ...rec.a, ...line(first) }, b: { ...rec.b, ...line(last) } };
    const rr = GS.gapRows({ truth: slot(F, 'T'), segments: segs, explained: slot(F, 'EF'), matches: slot(F, 'MF'), pairs: [r] },
      { gapMm: row.gapMm, separationMm: Math.hypot(row.gapMm, 4, 0) }, { moving: j.moving, target: j.target })
      .find((x) => x.refit && Math.abs(x.trueGapPx - row.trueGapPx) < 0.05);
    return rr?.refit;
  };
  const a = read(two), b = read(three);
  console.log(`${nameOf(g)} p${pairNo}: as fitted err ${row.refit.errorPx.toFixed(3)} | still held: err ${a?.errorPx?.toFixed(3)} mov ${a?.movingOffsetPx?.toFixed(3)} rms ${two?.rms.toFixed(4)}`
    + ` | held + ramp: err ${b?.errorPx?.toFixed(3)} mov ${b?.movingOffsetPx?.toFixed(3)} rms ${three?.rms.toFixed(4)} gain ${two && three ? (two.rms / three.rms).toFixed(2) : '-'}`);
}
