// Every file two analyses wrote, compared: the session logs' content hashes
// entry by entry, the feature lists byte for byte, and gap-sweep.json's rows.
// What may differ is only what records WHEN or HOW it ran.
//   node compare.js <dir a> <dir b>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [a, b] = process.argv.slice(2);
const files = fs.readdirSync(a).filter((f) => f.endsWith('.json')).sort();
let same = 0, differ = 0, hashes = 0;
// The run directories' own names appear in paths; they are the one
// difference the two analyses were given.
const names = [a, b].map((d) => path.basename(path.dirname(d)));
const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => {
  if (['analysedAt', 'environment', 'createdAt', 'elapsedMs', 'ms', 'when', 'replayedAt'].includes(k)) return undefined;
  return typeof v === 'string' ? names.reduce((s, n) => s.split(n).join('RUN'), v) : v;
}));
for (const f of files) {
  const fb = path.join(b, f);
  if (!fs.existsSync(fb)) { console.log(`missing in b: ${f}`); differ++; continue; }
  const ja = strip(JSON.parse(fs.readFileSync(path.join(a, f), 'utf8')));
  const jb = strip(JSON.parse(fs.readFileSync(fb, 'utf8')));
  if (f.endsWith('.session.json')) {
    for (const [i, e] of ja.entries.entries()) if (e.output?.hash) { hashes++; if (e.output.hash !== jb.entries[i]?.output?.hash) { console.log(`${f} entry ${e.n} ${e.text}: hash differs`); } }
  }
  if (JSON.stringify(ja) === JSON.stringify(jb)) same++;
  else { differ++; console.log(`differs: ${f}`); }
}
console.log(`${files.length} files: ${same} identical, ${differ} differ; ${hashes} content hashes compared`);
process.exit(differ ? 1 : 0);
