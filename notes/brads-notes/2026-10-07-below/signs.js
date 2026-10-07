// Every analysed run's truth gaps recomputed with this worktree's gapRows,
// against what the run recorded: a change in how a gap is signed would show
// as a flipped trueGapPx.   node signs.js [run-prefix ...]
'use strict';
const fs = require('node:fs'), path = require('node:path');
const R = path.join(__dirname, '../../../');
const GS = require(R + 'src/lab/gapsweep');
const prefixes = process.argv.slice(2);
let runs = 0, rows = 0, flipped = 0, moved = 0;
const byRun = new Map();
for (const dir of fs.readdirSync(R + 'results')) {
  if (prefixes.length && !prefixes.some((p) => dir.startsWith(p))) continue;
  const f = `${R}results/${dir}/pairs/gap-sweep.json`;
  if (!fs.existsSync(f)) continue;
  let sweep;
  try { sweep = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  if (!sweep.moving || !Array.isArray(sweep.rows)) continue;
  runs++;
  const shots = [...new Set(sweep.rows.map((r) => r.shot).filter(Boolean))];
  for (const shot of shots) {
    const ff = `${R}results/${dir}/pairs/${shot.replace(/\.png$/, '')}.features.json`;
    if (!fs.existsSync(ff)) continue;
    const by = Object.fromEntries(JSON.parse(fs.readFileSync(ff, 'utf8')).map((l) => [l.slot, l.features]));
    if (!by.T) continue;
    const old = sweep.rows.filter((r) => r.shot === shot && Number.isFinite(r.trueGapPx));
    const s0 = old[0] ?? sweep.rows.find((r) => r.shot === shot);
    const shotInfo = { name: shot, gapMm: s0.gapMm, view: { yaw: s0.yaw, elevation: s0.elevation }, poseMm: s0.poseMm, turnDeg: s0.turnDeg };
    let fresh;
    try {
      fresh = GS.gapRows({ truth: by.T, segments: by.F ?? [], explained: by.EF ?? [], matches: by.MF ?? [], pairs: null, tracks: [] },
        shotInfo, { moving: sweep.moving, target: sweep.target }, { maxAngle: 12 });
    } catch { continue; }
    for (const o of old) {
      const n = fresh.find((r) => r.truthPair && o.truthPair && r.truthPair.join() === o.truthPair.join());
      if (!n || !Number.isFinite(n.trueGapPx)) continue;
      rows++;
      if (Math.sign(n.trueGapPx) !== Math.sign(o.trueGapPx) && Math.abs(o.trueGapPx) > 1e-9) {
        flipped++;
        const k = `${dir} ${s0.yaw}/${s0.elevation}`; byRun.set(k, (byRun.get(k) ?? 0) + 1);
        if (process.env.VERBOSE) console.log(`flipped ${dir} ${shot} pair ${o.pair}: ${o.trueGapPx.toFixed(3)} -> ${n.trueGapPx.toFixed(3)}`);
      } else if (Math.abs(n.trueGapPx - o.trueGapPx) > 1e-6) moved++;
    }
  }
}
for (const [k, n] of byRun) console.log(`  ${k}: ${n}`);
console.log(`${runs} runs, ${rows} truth gaps: ${flipped} flipped, ${moved} otherwise changed`);
