// Tracked error per view and pose for one pair: node bypose.js <pair> <results dir> ...
'use strict';
const fs = require('node:fs'), path = require('node:path');
const [pair, ...dirs] = process.argv.slice(2);
for (const dir of dirs) {
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'pairs', 'gap-sweep.json'), 'utf8'));
  const views = new Map();
  for (const r of run.rows) {
    if (String(r.pair) !== pair) continue;
    const k = `${r.yaw}/${r.elevation}`;
    if (!views.has(k)) views.set(k, []);
    const t = r.tracked;
    views.get(k).push(`${String(r.gapMm).padStart(5)}:${t && Number.isFinite(t.gapPx) ? (t.errorPx >= 0 ? '+' : '') + t.errorPx.toFixed(3) + (t.model === 'edge' ? 'e' : '') : '  --  '}(${r.trueGapPx.toFixed(1)})`);
  }
  console.log(dir);
  for (const [k, v] of views) console.log(`  ${k.padEnd(6)} ${v.join(' ')}`);
}
