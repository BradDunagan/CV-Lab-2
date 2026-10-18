// trackPair with TRACK_EDGE_RATIO lowered to CUT, without re-running it: a
// track called an overhang at a ratio of CUT or over becomes ambiguous, which
// gives no reading. Writes results/scatter-cut<CUT>/<run>/gap-sweep.json.
//   node notes/brads-notes/2026-10-18-scatter/cutoff.js 0.98
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const CUT = Number(process.argv[2]);
const RUNS = [96, 150, 300].flatMap((S) => [1, 2, 3].map((r) => `stack-2g-test-s${S}-r${r}-ledge`));
let refused = 0;
for (const run of RUNS) {
  const dir = path.join('results', run, 'pairs');
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'gap-sweep.json'), 'utf8'));
  const rows = rec.rows.map((row) => {
    if (!row.tracked || !Number.isFinite(row.tracked.gapPx)) return row;
    const slots = Object.values(JSON.parse(fs.readFileSync(path.join(dir, row.shot.replace(/\.png$/, '.features.json')), 'utf8')));
    // The row's own track: the edge-track whose gap is the row's reading, which
    // the row measures again at the pair's middle (they agree to ~0.002 px).
    const mine = slots.filter((s) => /^K\d+$/.test(s.slot)).map((s) => s.features[0])
      .find((f) => f && f.model === 'edge' && f.ratio >= CUT && Math.abs(Math.abs(f.gap) - Math.abs(row.tracked.gapPx)) < 0.05);
    if (!mine) return row;
    refused++;
    return { ...row, tracked: null };
  });
  const out = path.join('results', `scatter-cut${CUT}`, run);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'gap-sweep.json'), JSON.stringify({ ...rec, rows }));
}
console.log(`cut ${CUT}: ${refused} readings refused over ${RUNS.length} runs`);
