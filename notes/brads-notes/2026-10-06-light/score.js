// A light's score from its hinged no-truth solve: the calibration's own
// straightness (each carried reading's RMS about its fitted model over its
// calibration frames: max, median, how many over 0.1 and 0.2 px) and the
// test poses' error (ten multi-view sets, and four views).
//   node score.js results/light/<prefix>-hinged.json ...
'use strict';
const fs = require('node:fs');
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : '  -  ');
for (const file of process.argv.slice(2)) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rms = (d.calibrated ?? []).map((p) => p.calibration?.rms).filter(Number.isFinite).sort((a, b) => a - b);
  const multi = d.sets.filter((s) => s.views.length >= 2 && s.determined && s.test.carried.solved > 0
    && s.views.join('+') !== 'yaw 35, elev 50+yaw 60, elev 50');
  const pooled = [0, 1, 2, 3].map((k) => Math.sqrt(multi.reduce((a, s) => a + s.test.carried.rms[k] ** 2, 0) / multi.length));
  const four = d.sets.find((s) => s.views.length === 4)?.test.carried;
  console.log(`${file.split('/').pop().padEnd(28)} calib rms max ${f3(rms.at(-1))} median ${f3(rms[(rms.length - 1) >> 1])} `
    + `>0.1: ${rms.filter((v) => v > 0.1).length}/${rms.length} >0.2: ${rms.filter((v) => v > 0.2).length}   `
    + `ten sets ${pooled.map(f3).join(' / ')}   four views ${four ? four.rms.map(f3).join(' / ') : '-'} (${four?.solved}/${four?.of})`);
}
