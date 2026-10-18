// What ratio trackPair sees over real strips and real overhangs: every track in
// the stack-2g sweeps and the nine ledge-consistent test sets, with the truth
// beside it. `ratio` is the one edge's rms over the two's; trackPair calls an
// overhang below TRACK_EDGE_RATIO (1.0), a strip at TRACK_STRIP_RATIO (1.2) or
// over, and between gives no reading.
//   node notes/brads-notes/2026-10-18-scatter/ratios.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const RUNS = ['stack-2g-x', 'stack-2g-y', 'stack-2g-z', 'stack-2g-turn',
  ...[96, 150, 300].flatMap((S) => [1, 2, 3].map((r) => `stack-2g-test-s${S}-r${r}-ledge`))];

const tracks = [];
for (const run of RUNS) {
  const dir = path.join('results', run, 'pairs');
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'gap-sweep.json'), 'utf8'));
  for (const row of rec.rows) {
    const file = path.join(dir, row.shot.replace(/\.png$/, '.features.json'));
    if (!fs.existsSync(file) || !Number.isFinite(row.trueGapPx)) continue;
    const slots = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')))
      .filter((s) => /^K\d+$/.test(s.slot) && s.features.length);
    // The track for this row's pair: its still line runs at the row's pair angle.
    const angle = (l) => ((Math.atan2(l.y1 - l.y0, l.x1 - l.x0) * 180 / Math.PI) % 180 + 180) % 180;
    const off = (a, b) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); };
    const t = slots.map((s) => s.features[0])
      .filter((f) => f.type === 'edge-track' && Number.isFinite(f.ratio))
      .sort((a, b) => off(angle(a.still), row.pairAngle) - off(angle(b.still), row.pairAngle))[0];
    if (!t || off(angle(t.still), row.pairAngle) > 5) continue;
    tracks.push({ run, key: `${row.yaw}/${row.elevation}/${row.pose ?? row.gapMm}/${row.pair}`, truth: row.trueGapPx,
      ratio: t.ratio, freeRatio: t.freeRatio, model: t.model, gap: t.gap, moving: row.moving });
  }
}

const f3 = (v) => (v == null || !Number.isFinite(v) ? '    -' : v.toFixed(3).padStart(6));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
console.log(`${tracks.length} tracks from ${RUNS.length} runs\n`);

// Ratio by true gap, in bands: where overhangs and strips each fall.
const BANDS = [[-Infinity, -1], [-1, -0.5], [-0.5, -0.25], [-0.25, 0], [0, 0.25], [0.25, 0.5], [0.5, 1], [1, 2], [2, Infinity]];
console.log('true gap, px      tracks   ratio min    p10    p50    p90    max   edge  ambig  strip');
for (const [lo, hi] of BANDS) {
  const b = tracks.filter((t) => t.truth >= lo && t.truth < hi);
  if (!b.length) continue;
  const r = b.map((t) => t.ratio);
  const n = (m) => String(b.filter((t) => t.model === m).length).padStart(6);
  console.log(`${String(lo).padStart(5)} .. ${String(hi).padEnd(5)}  ${String(b.length).padStart(6)}   ${f3(Math.min(...r))} ${f3(q(r, 0.1))} ${f3(q(r, 0.5))} ${f3(q(r, 0.9))} ${f3(Math.max(...r))} ${n('edge')} ${n('ambiguous')} ${n('strip')}`);
}

// Every track called an overhang: how far the truth is from what was read.
console.log('\ncalled an overhang (ratio < 1.0): ratio, true gap, read gap, error');
const edges = tracks.filter((t) => t.model === 'edge').sort((a, b) => a.ratio - b.ratio);
for (const t of edges) console.log(`  ${f3(t.ratio)}  ${f3(t.truth)}  ${f3(t.gap)}  ${f3(t.gap - t.truth)}   ${t.run} ${t.key}`);

// What a dead band would keep: real overhangs read, and wrong ones refused.
console.log('\nedge cutoff   overhangs read right   strips read as overhangs');
for (const cut of [1.0, 0.99, 0.98, 0.97, 0.95, 0.9]) {
  const read = edges.filter((t) => t.ratio < cut);
  const right = read.filter((t) => Math.abs(t.gap - t.truth) < 0.25).length;
  console.log(`   ${cut.toFixed(2)}        ${String(right).padStart(6)} of ${String(read.length).padEnd(6)}       ${read.filter((t) => t.truth > 0 && t.gap < 0).length}`);
}

// Overhangs called strips, if any: what they are.
if (process.argv[2] === 'odd') {
  console.log('\noverhangs (truth < 0) called strips');
  for (const t of tracks.filter((t) => t.truth < 0 && t.model === 'strip'))
    console.log(`  ${f3(t.ratio)} free ${f3(t.freeRatio)}  true ${f3(t.truth)}  read ${f3(t.gap)}  moving ${t.moving}  ${t.run} ${t.key}`);
}
