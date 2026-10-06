// Repeatability: the same poses rendered more than once, differing only in
// the path tracer's noise. Splits each error into the part every render
// repeats (bias) and the part that changes from render to render (scatter).
//
//   node notes/brads-notes/2026-10-05-repeat/repeat.js <results dir | gap-sweep.json> ... [-- <position.json> ...]
//
// The results dirs are gap-sweep runs of the same --poses (each a pairs/ dir
// holding gap-sweep.json). The position files are `npm run position -- --out`
// of each, in the same order.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const cut = args.indexOf('--');
// A results dir, or a gap-sweep.json saved elsewhere.
const recordOf = (d) => (d.endsWith('.json') ? d : path.join(d, 'gap-sweep.json'));
const runs = (cut < 0 ? args : args.slice(0, cut)).map((d) => JSON.parse(fs.readFileSync(recordOf(d), 'utf8')));
const solves = cut < 0 ? [] : args.slice(cut + 1).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const rms = (a) => Math.sqrt(mean(a.map((v) => v * v)));
const f3 = (v) => (v == null || !Number.isFinite(v) ? '   -  ' : v.toFixed(3).padStart(6));

// One reading: a view, a pose, a pair, and where along it (mid, end 1, end 2).
const MODES = {
  detected: (r) => (r.pairFound ? [r.measuredGapPx, ...(r.endsDetectedPx || [null, null])] : null),
  refit: (r) => (r.refit && Number.isFinite(r.refit.gapPx) ? [r.refit.gapPx, ...(r.refit.endsPx || [null, null])] : null),
  tracked: (r) => (r.tracked && Number.isFinite(r.tracked.gapPx) ? [r.tracked.gapPx, ...(r.tracked.endsPx || [null, null])] : null),
};
const truthOf = (r) => [r.trueGapPx, ...(r.endsTruePx || [null, null])];
const WHERE = ['mid', 'end 1', 'end 2'];

const key = (r) => `${r.yaw}/${r.elevation}/${r.pose}/${r.pair}`;
const byKey = runs.map((run) => new Map(run.rows.map((r) => [key(r), r])));
const keys = [...byKey[0].keys()].filter((k) => byKey.every((m) => m.has(k)));

console.log(`${runs.length} renders of ${keys.length} pair-views (${new Set(keys.map((k) => k.split('/').slice(0, 2).join('/'))).size} views)\n`);
console.log('reading error, px      read   bias rms   scatter sd   total rms   worst scatter');
for (const [mode, read] of Object.entries(MODES)) {
  for (const pair of [1, 2]) {
    for (let w = 0; w < 3; w++) {
      const biases = [], sds = [], all = []; let worst = { sd: -1 };
      let readAll = 0;
      for (const k of keys.filter((k) => k.endsWith(`/${pair}`))) {
        const rows = byKey.map((m) => m.get(k));
        const vals = rows.map((r) => { const v = read(r); return v && Number.isFinite(v[w]) ? v[w] - truthOf(r)[w] : null; });
        if (vals.some((v) => v == null)) continue;
        readAll++;
        biases.push(mean(vals)); sds.push(sd(vals)); all.push(...vals);
        if (sds.at(-1) > worst.sd) worst = { sd: sds.at(-1), k, vals };
      }
      if (!readAll) continue;
      // Pooled scatter: root of the mean variance, so it adds to bias^2 as total^2 does.
      const pooled = Math.sqrt(mean(sds.map((s) => s * s)));
      console.log(`${mode.padEnd(9)} pair ${pair} ${WHERE[w].padEnd(6)} ${String(readAll).padStart(3)}/${keys.filter((k) => k.endsWith(`/${pair}`)).length}  ${f3(rms(biases))}     ${f3(pooled)}      ${f3(rms(all))}    ${worst.k} ${worst.vals.map(f3).join(' ')}`);
    }
  }
}

// Which frame each view and pair was carried from, render by render.
console.log('\ncarried from (render by render)');
const src = (run) => new Map((run.carry?.sources || []).map((s) => [`${s.yaw}/${s.elevation}/${s.pair}`, s]));
const srcs = runs.map(src);
for (const k of srcs[0].keys()) {
  const s = srcs.map((m) => m.get(k));
  console.log(`  ${k.padEnd(10)} ${s.map((x) => (x ? `${x.from.replace(/^y\d+-e\d+-/, '').replace('.png', '')} (${x.gapPx.toFixed(2)} px, gain ${x.ledgeGain.toFixed(2)})` : 'none').padEnd(28)).join('')}`);
}

if (solves.length) {
  const UNK = ['x mm', 'y mm', 'z mm', 'turn deg'];
  console.log('\nsolved test poses, mm and degrees: bias rms / scatter sd / total rms over the poses');
  const sets = solves[0].sets.map((s) => s.views.join(' + '));
  for (const mode of ['refit', 'carried']) {
    for (const [si, name] of sets.entries()) {
      if (solves[0].sets[si].views.length < 2) continue;
      const per = solves.map((s) => new Map(s.sets[si].test[mode].byPose.map((p) => [p.pose, p.error])));
      const poses = [...per[0].keys()].filter((p) => per.every((m) => m.has(p)));
      const cols = UNK.map((_, u) => {
        const b = [], v = [], a = [];
        for (const p of poses) {
          const e = per.map((m) => m.get(p)[u]);
          b.push(mean(e)); v.push(sd(e) ** 2); a.push(...e);
        }
        return `${f3(rms(b))} /${f3(Math.sqrt(mean(v)))} /${f3(rms(a))}`;
      });
      console.log(`${mode.padEnd(8)} ${String(poses.length).padStart(2)} poses  ${cols.join('   ')}   ${name}`);
    }
  }
  console.log(`         columns: ${UNK.join(', ')}`);
}
