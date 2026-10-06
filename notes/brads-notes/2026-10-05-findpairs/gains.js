// findPairs' gain against whether two real edges are there.
//   node gains.js <results dir>...   (each holding lowgain.lab's *.features.json)
// A find is REAL when two visible truth edges lie under its two fitted lines:
// each within 0.6 px of one, at the find's middle, and within 5 degrees of it.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const finds = [];
for (const dir of process.argv.slice(2)) {
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.features.json'))) {
    const slots = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).map((s) => [s.slot, s.features]));
    const truth = (slots.T ?? []).filter((t) => t.type === 'gt-edge' && t.visible !== 0);
    for (const h of slots.H ?? []) {
      const under = (e) => truth.filter((t) => {
        const dx = t.x1 - t.x0, dy = t.y1 - t.y0, len = Math.hypot(dx, dy);
        if (len < 1) return false;
        const ex = e.x1 - e.x0, ey = e.y1 - e.y0, el = Math.hypot(ex, ey);
        if (Math.abs(dx * ey - dy * ex) / (len * el) > Math.sin(5 * Math.PI / 180)) return false;
        const mx = (e.x0 + e.x1) / 2, my = (e.y0 + e.y1) / 2;
        const along = ((mx - t.x0) * dx + (my - t.y0) * dy) / len;
        if (along < -2 || along > len + 2) return false;
        return Math.abs((mx - t.x0) * dy - (my - t.y0) * dx) / len <= 0.6;
      }).map((t) => t.id);
      const a = under(h.a), b = under(h.b);
      const real = a.some((i) => b.some((j) => j !== i));
      finds.push({ run: dir, frame: f, gain: h.gain, gap: h.gap, real });
    }
  }
}
const real = finds.filter((x) => x.real), not = finds.filter((x) => !x.real);
console.log(`${finds.length} finds: ${real.length} real, ${not.length} not`);
const edges = [1.0, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5, 1.75, 2, 3, 100];
console.log('gain from   real  not');
for (let i = 0; i < edges.length - 1; i++) {
  const inBin = (x) => x.gain >= edges[i] && x.gain < edges[i + 1];
  console.log(`  ${edges[i].toFixed(2).padStart(5)}    ${String(real.filter(inBin).length).padStart(4)} ${String(not.filter(inBin).length).padStart(4)}`);
}
for (const t of [1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5]) {
  const kept = finds.filter((x) => x.gain >= t);
  console.log(`minGain ${t}: keeps ${kept.filter((x) => x.real).length}/${real.length} real, ${kept.filter((x) => !x.real).length}/${not.length} not`);
}
