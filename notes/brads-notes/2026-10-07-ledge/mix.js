// Rows from <run><from> where pick(row) holds, the rest from <run>:
//   node mix.js <from suffix> <to suffix> <predicate> <run> ...
// predicate: 'slidback' -- the commanded x below -0.25 mm.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const R = path.join(__dirname, '../../../');
const [from, to, pred, ...runs] = process.argv.slice(2);
const xOf = (j, r) => (r.poseMm ? r.poseMm[0] : (j.offsetMm?.[0] ?? 0) + (j.axis?.[0] ?? 0) * r.gapMm);
for (const run of runs) {
  const a = JSON.parse(fs.readFileSync(R + `results/${run}/pairs/gap-sweep.json`, 'utf8'));
  const b = JSON.parse(fs.readFileSync(R + `results/${run}${from}/pairs/gap-sweep.json`, 'utf8'));
  let n = 0;
  const rows = a.rows.map((o, i) => (pred === 'slidback' && xOf(a, o) < -0.25 ? (n++, b.rows[i]) : o));
  fs.mkdirSync(R + `results/${run}${to}/pairs`, { recursive: true });
  fs.writeFileSync(R + `results/${run}${to}/pairs/gap-sweep.json`, JSON.stringify({ ...a, rows }, null, 1));
  console.log(`${run}${to}: ${n} rows from ${from}`);
}
