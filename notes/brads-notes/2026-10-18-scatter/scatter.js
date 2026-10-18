// Where a solved pose's render-to-render scatter comes from, when it does not
// follow the samples (§5, "A forty-second"). Reads the ledge-consistent runs
// of 2026-10-18-samples/run.sh: three renders at each of 96, 150, 300.
//   node notes/brads-notes/2026-10-18-scatter/scatter.js
'use strict';
const fs = require('node:fs');

const COUNTS = [96, 150, 300];
const run = (S, r) => `results/stack-2g-test-s${S}-r${r}-ledge`;
const record = (S, r) => JSON.parse(fs.readFileSync(`${run(S, r)}/pairs/gap-sweep.json`, 'utf8'));
const solve = (S, r) => JSON.parse(fs.readFileSync(`results/samples/stack-2g-test-s${S}-r${r}-ledge-hinged.json`, 'utf8'));

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f3 = (v) => (v == null || !Number.isFinite(v) ? '   -  ' : v.toFixed(3).padStart(6));
const key = (r) => `${r.yaw}/${r.elevation}/${r.pose}/${r.pair}`;

// A. Each tracked reading (middle and both ends) across a count's three renders.
console.log('A. tracked readings, render-to-render sd, px');
console.log('   samples  readings  in all 3  in some   median    p90    max');
const perReading = {};
for (const S of COUNTS) {
  const maps = [1, 2, 3].map((r) => new Map(record(S, r).rows.map((row) => [key(row), row])));
  const keys = new Set(maps.flatMap((m) => [...m.keys()]));
  const sds = {}; let all = 0, some = 0;
  for (const k of keys) {
    const vals = maps.map((m) => {
      const t = m.get(k)?.tracked;
      return t && Number.isFinite(t.gapPx) ? [t.gapPx, ...(t.endsPx || [null, null])] : null;
    });
    const n = vals.filter(Boolean).length;
    if (n === 3) all++; else if (n > 0) some++;
    if (n < 3) continue;
    for (let w = 0; w < 3; w++) {
      const v = vals.map((x) => x[w]);
      if (v.every(Number.isFinite)) sds[`${k}/${w}`] = sd(v);
    }
  }
  perReading[S] = sds;
  const s = Object.values(sds);
  console.log(`   ${String(S).padStart(7)}  ${String(s.length).padStart(8)}  ${String(all).padStart(8)}  ${String(some).padStart(7)}  ${f3(q(s, 0.5))} ${f3(q(s, 0.9))} ${f3(Math.max(...s))}`);
}
const common = Object.keys(perReading[96]).filter((k) => k in perReading[300]);
const ratios = common.map((k) => perReading[96][k] / perReading[300][k]);
console.log(`   96 over 300, reading by reading (${common.length}): median ${f3(q(ratios, 0.5))}, quartiles ${f3(q(ratios, 0.25))} ${f3(q(ratios, 0.75))}`);

// B. Each pose's solved error across a count's renders: which poses carry the scatter.
console.log('\nB. four views, hinged: each pose\'s render-to-render sd, x / y / z mm, turn deg');
const ALL4 = (d) => d.sets.find((s) => s.views.length === 4).test.carried.byPose;
const byPose = {};
for (const S of COUNTS) {
  const renders = [1, 2, 3].map((r) => new Map(ALL4(solve(S, r)).map((p) => [p.pose, p.error])));
  byPose[S] = renders;
}
console.log('   pose        ' + COUNTS.map((S) => `${S} samples`.padEnd(30)).join(''));
for (const pose of byPose[300][0].keys()) {
  const cells = COUNTS.map((S) => {
    const e = byPose[S].map((m) => m.get(pose));
    if (e.some((x) => !x)) return '  -'.padEnd(30);
    return [0, 1, 2, 3].map((k) => f3(sd(e.map((x) => x[k])))).join(' ').padEnd(30);
  });
  console.log(`   ${pose.padEnd(10)}  ${cells.join('')}`);
}
