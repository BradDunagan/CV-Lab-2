// Test-pose error from `npm run position --out` files: the carried mode,
// x / y / z mm and turn degrees. "sets": the RMS over every determined set of
// two or more views but the weak 35/50 + 60/50 pair (as §5's tables);
// "4 views": the set of all four.
//   node summary.js <position.json> ...
'use strict';
const fs = require('node:fs');
const f3 = (v) => (v == null || !Number.isFinite(v) ? '  -  ' : v.toFixed(3));
for (const file of process.argv.slice(2)) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const multi = d.sets.filter((s) => s.views.length >= 2 && s.determined
    && s.views.join('+') !== 'yaw 35, elev 50+yaw 60, elev 50' && s.test.carried.solved > 0);
  const all = d.sets.find((s) => s.views.length === 4);
  const pooled = [0, 1, 2, 3].map((k) => Math.sqrt(multi.reduce((a, s) => a + s.test.carried.rms[k] ** 2, 0) / multi.length));
  const four = all ? all.test.carried.rms : [null, null, null, null];
  console.log(`${file.split('/').pop().padEnd(40)} ${multi.length} sets ${pooled.map(f3).join(' / ')}   4 views ${four.map(f3).join(' / ')}  (${all?.test.carried.solved}/${all?.test.carried.of})`);
}
