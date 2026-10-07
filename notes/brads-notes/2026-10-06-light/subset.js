// Rows of one light's runs kept for a cheaper search (see subset.sh):
//   node subset.js <prefix>   -> results/<prefix>-<run>-sub/pairs/gap-sweep.json
'use strict';
const fs = require('node:fs'), path = require('node:path');
const R = path.join(__dirname, '../../../results/');
const pre = process.argv[2];
// TEST: which commanded test poses are the verdict (1-based), and the suffix.
const TEST = (process.env.TEST ?? '1,4,7').split(',').map(Number), SUF = process.env.SUF ?? '-sub';
const keep = {
  x: (r) => [-2, 0, 2].includes(r.gapMm),
  y: (r) => [-2, 0, 2].includes(r.gapMm),
  z: (r) => [-2, 0, 2].includes(r.gapMm),
  turn: (r) => [2, 3, 4].includes(r.pose),
  test: (r) => TEST.includes(r.pose),
};
for (const [run, ok] of Object.entries(keep)) {
  const j = JSON.parse(fs.readFileSync(`${R}${pre}-${run}/pairs/gap-sweep.json`, 'utf8'));
  const out = { ...j, rows: j.rows.filter(ok), subsetOf: `${pre}-${run}` };
  if (run === 'test' && j.poses) out.poses = j.poses.filter((_, k) => TEST.includes(k + 1));
  fs.mkdirSync(`${R}${pre}-${run}${SUF}/pairs`, { recursive: true });
  fs.writeFileSync(`${R}${pre}-${run}${SUF}/pairs/gap-sweep.json`, JSON.stringify(out));
}
