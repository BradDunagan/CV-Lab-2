// The counterfactual: every tracked reading that some renders give and others
// refuse, dropped from all nine, so the solves see the same readings in every
// render. Writes results/scatter/<run>/gap-sweep.json for each, then
//   node notes/brads-notes/2026-10-18-scatter/drop.js
// and solve them as run.sh does (see run.sh beside this).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const RUNS = [96, 150, 300].flatMap((S) => [1, 2, 3].map((r) => `stack-2g-test-s${S}-r${r}-ledge`));
const key = (x) => `${x.yaw}/${x.elevation}/${x.pose}/${x.pair}`;
const read = (x) => x.tracked && Number.isFinite(x.tracked.gapPx);

const records = RUNS.map((n) => JSON.parse(fs.readFileSync(`results/${n}/pairs/gap-sweep.json`, 'utf8')));
const count = new Map();
for (const rec of records) for (const x of rec.rows) count.set(key(x), (count.get(key(x)) || 0) + (read(x) ? 1 : 0));
const switching = [...count].filter(([, n]) => n > 0 && n < RUNS.length).map(([k]) => k);
console.log(`dropped from every render: ${switching.join(', ')}`);

RUNS.forEach((n, i) => {
  const rec = records[i];
  const rows = rec.rows.map((x) => (switching.includes(key(x)) ? { ...x, tracked: null } : x));
  const dir = path.join('results', 'scatter', n);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gap-sweep.json'), JSON.stringify({ ...rec, rows }));
});
